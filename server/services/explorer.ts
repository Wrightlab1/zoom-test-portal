import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { AuthorizationRow } from '../db/authorizations.js';
import type { ApiCallRow } from '../db/calls.js';
import { fillPathVariables, resolveVars } from '../lib/postman.js';
import { sendOutbound, type OutboundResult } from '../lib/outbound.js';
import { isAllowed } from '../lib/allowlist.js';
import { parseZoomError } from './callLog.js';
import { TokenError } from './tokens.js';
import type { Services } from './index.js';

const kv = z.object({ key: z.string(), value: z.string().default(''), enabled: z.boolean().default(true) });

export const sendInput = z.object({
  profileId: z.number().int().positive(),
  authorizationId: z.number().int().positive().nullable().optional(),
  auth: z.enum(['profile', 'none']).default('profile'),
  method: z.string().trim().toUpperCase().pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])),
  url: z.string().trim().min(1).max(8000),
  pathVariables: z.record(z.string(), z.string()).default({}),
  encoding: z.record(z.string(), z.enum(['auto', 'single', 'double'])).default({}),
  query: z.array(kv).default([]),
  headers: z.array(kv).default([]),
  body: z.string().max(16 * 1024 * 1024).nullable().optional(),
  environmentId: z.number().int().positive().nullable().optional(),
  collectionId: z.number().int().positive().nullable().optional(),
  collectionRequestId: z.number().int().positive().nullable().optional(),
  savedRequestId: z.number().int().positive().nullable().optional(),
  /** Retry once on 401 "expired" after refreshing (default true). */
  retryOnExpired: z.boolean().default(true),
});
export type SendInput = z.infer<typeof sendInput>;

export interface Prepared {
  url: string;
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  warnings: string[];
  authRow: AuthorizationRow | null;
  accessToken: string | null;
}

/** Zoom says the token expired: {code:124|201, message:"Access token is expired."}. "Invalid access token" is not retried. */
export function isExpiredTokenResponse(r: OutboundResult): boolean {
  if (r.status !== 401) return false;
  const { code, message } = parseZoomError(r.body.toString('utf8'));
  return /expired/i.test(message ?? '') || code === '201';
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class ExplorerService {
  constructor(
    private ctx: Ctx,
    private s: Services,
  ) {}

  private vars(input: SendInput, authRow: AuthorizationRow | null): Record<string, string> {
    const vars: Record<string, string> = {};
    if (input.collectionId) {
      const c = this.s.collections.get(input.collectionId);
      if (c) for (const v of this.s.collections.variables(c)) if (!v.disabled) vars[v.key] = v.value;
    }
    if (input.environmentId) {
      for (const v of this.s.collections.environmentValues(input.environmentId) ?? []) if (!v.disabled) vars[v.key] = v.value;
    }
    // {{baseUrl}} always follows the token's regional api_url.
    const api = (authRow?.api_url ?? this.ctx.settings.get().apiBaseUrl).replace(/\/+$/, '');
    vars.baseUrl = `${api}/v2`;
    vars.apiUrl = api;
    return vars;
  }

  /** Resolve the authorization to use for a profile. */
  private async resolveAuth(input: SendInput): Promise<{ row: AuthorizationRow | null; token: string | null }> {
    const p = this.s.profiles.get(input.profileId);
    if (!p) throw new TokenError('Profile not found', 'not_found', 404);
    if (input.auth === 'none') {
      const row = input.authorizationId ? this.s.auths.get(input.authorizationId) : p.type === 's2s' ? this.s.auths.s2sFor(p.id) : null;
      return { row, token: null };
    }
    if (p.type === 's2s') {
      const { row, accessToken } = await this.s.tokens.s2sToken(p.id);
      return { row, token: accessToken };
    }
    let authId = input.authorizationId ?? null;
    if (!authId) {
      const active = this.s.auths.listForProfile(p.id, false).filter((a) => a.status === 'active');
      if (!active.length) throw new TokenError('This profile has no active authorization. Click Authorize first.', 'no_authorization', 409);
      authId = active[0].id;
    }
    const a = this.s.auths.get(authId);
    if (!a || a.profile_id !== p.id) throw new TokenError('Authorization does not belong to this profile', 'invalid', 400);
    const { row, accessToken } = await this.s.tokens.accessTokenFor(authId);
    return { row, token: accessToken };
  }

  async prepare(input: SendInput, opts: { withToken: boolean } = { withToken: true }): Promise<Prepared> {
    const warnings: string[] = [];
    const { row, token } = opts.withToken ? await this.resolveAuth(input) : { row: input.authorizationId ? this.s.auths.get(input.authorizationId) : this.s.auths.s2sFor(input.profileId), token: null };
    const vars = this.vars(input, row);
    const unresolved = new Set<string>();
    const missingPath = new Set<string>();

    let urlStr = resolveVars(input.url, vars, unresolved);
    const pathVars = Object.fromEntries(Object.entries(input.pathVariables).map(([k, v]) => [k, resolveVars(v, vars, unresolved)]));
    // The endpoint template (for grouping in reports) is the path before variables are filled.
    let endpoint: string;
    try {
      endpoint = new URL(urlStr.replace(/\?.*$/, '')).pathname.replace(/^\/v2(?=\/)/, '') || '/';
    } catch {
      endpoint = urlStr;
    }
    if (input.collectionRequestId) {
      const cr = this.s.collections.getRequest(input.collectionRequestId);
      if (cr) endpoint = cr.path_template;
    }
    urlStr = fillPathVariables(urlStr, pathVars, input.encoding, missingPath);

    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new TokenError(`Not a valid URL after resolving variables: ${urlStr}`, 'invalid_url', 400);
    }
    for (const q of input.query) {
      if (q.enabled && q.key) url.searchParams.append(resolveVars(q.key, vars, unresolved), resolveVars(q.value, vars, unresolved));
    }

    const headers: Record<string, string> = {};
    for (const h of input.headers) {
      if (!h.enabled || !h.key) continue;
      if (input.auth === 'profile' && h.key.toLowerCase() === 'authorization') {
        warnings.push('Ignored your Authorization header: the portal attaches the profile token. Choose "No auth" to send your own.');
        continue;
      }
      headers[h.key] = resolveVars(h.value, vars, unresolved);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | null = input.body == null || input.body === '' || input.method === 'GET' || input.method === 'HEAD' ? null : resolveVars(input.body, vars, unresolved);
    if (body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.Accept = 'application/json';
    if (body && body.includes('[REDACTED]')) warnings.push('The body contains a redacted placeholder from the log; replace it with the real value.');

    if (unresolved.size) warnings.push(`Unresolved variables: ${[...unresolved].map((v) => `{{${v}}}`).join(', ')}`);
    if (missingPath.size) warnings.push(`Path variables without a value: ${[...missingPath].map((v) => `:${v}`).join(', ')}`);
    const p = this.s.profiles.get(input.profileId);
    if (p?.type === 's2s' && /\/users\/me(\/|$)/.test(url.pathname)) {
      warnings.push('Server-to-Server tokens must not use "me" — Zoom expects an explicit userId or email.');
    }
    if (!isAllowed(url, this.ctx.settings.get().allowlist)) warnings.push(`${url.host} is not in the outbound allowlist; the request will be blocked.`);
    return { url: url.toString(), endpoint, method: input.method, headers, body, warnings, authRow: row, accessToken: token };
  }

  private async sendOnce(prep: Prepared, input: SendInput, meta: { attempt: number; retryOf?: number | null; replayOf?: number | null }): Promise<{ call: ApiCallRow; result: OutboundResult }> {
    const result = await sendOutbound(
      { method: prep.method, url: prep.url, headers: prep.headers, body: prep.body, timeoutMs: 60_000 },
      this.ctx.settings.get().allowlist,
    );
    const p = this.s.profiles.get(input.profileId);
    const call = this.s.callLog.log({
      category: 'api',
      profileId: input.profileId,
      authorizationId: prep.authRow?.id ?? null,
      authType: input.auth === 'none' ? 'none' : (p?.type ?? null),
      method: prep.method,
      url: prep.url,
      endpoint: prep.endpoint,
      collectionRequestId: input.collectionRequestId ?? null,
      savedRequestId: input.savedRequestId ?? null,
      reqHeaders: prep.headers,
      reqBody: prep.body,
      attempt: meta.attempt,
      retryOf: meta.retryOf ?? null,
      replayOf: meta.replayOf ?? null,
      result,
    });
    return { call, result };
  }

  /** Send, and on 401 "expired" refresh once and retry once. Both attempts are logged. */
  async send(input: SendInput, opts: { replayOf?: number | null } = {}): Promise<{ calls: ApiCallRow[]; warnings: string[] }> {
    const prep = await this.prepare(input);
    const first = await this.sendOnce(prep, input, { attempt: 1, replayOf: opts.replayOf });
    const calls = [first.call];
    if (input.auth === 'profile' && input.retryOnExpired && prep.authRow && isExpiredTokenResponse(first.result)) {
      try {
        const renewed = await this.s.tokens.renewAfterExpiry(prep.authRow);
        const retryPrep = { ...prep, headers: { ...prep.headers, Authorization: `Bearer ${renewed.accessToken}` }, authRow: renewed.row };
        const second = await this.sendOnce(retryPrep, input, { attempt: 2, retryOf: first.call.id, replayOf: opts.replayOf });
        calls.push(second.call);
      } catch (e) {
        prep.warnings.push(`Got 401 (token expired) but refreshing failed: ${(e as Error).message}`);
      }
    }
    return { calls, warnings: prep.warnings };
  }

  /** Reconstruct a send request from a logged call. */
  inputFromCall(row: ApiCallRow): SendInput {
    if (row.category !== 'api') throw new TokenError('Only API calls can be re-run (token endpoint calls are not replayable).', 'invalid', 400);
    if (!row.profile_id) throw new TokenError('This call has no profile', 'invalid', 400);
    const headers = Object.entries(JSON.parse(row.req_headers ?? '{}') as Record<string, string>)
      .filter(([k]) => !['authorization', 'content-length', 'host'].includes(k.toLowerCase()))
      .map(([key, value]) => ({ key, value, enabled: true }));
    return sendInput.parse({
      profileId: row.profile_id,
      authorizationId: row.authorization_id,
      auth: row.auth_type === 'none' ? 'none' : 'profile',
      method: row.method,
      url: row.url,
      headers,
      body: row.req_body,
      collectionRequestId: row.collection_request_id,
      savedRequestId: row.saved_request_id,
    });
  }

  async replay(callId: number) {
    const row = this.s.calls.get(callId);
    if (!row) throw new TokenError('Call not found', 'not_found', 404);
    return this.send(this.inputFromCall(row), { replayOf: callId });
  }

  /** curl for a logged call. The token is a shell variable unless `reveal` is set. */
  curlForCall(callId: number, reveal: boolean): string {
    const row = this.s.calls.get(callId);
    if (!row) throw new TokenError('Call not found', 'not_found', 404);
    const headers = Object.entries(JSON.parse(row.req_headers ?? '{}') as Record<string, string>).filter(([k]) => !['content-length', 'host'].includes(k.toLowerCase()));
    let token: string | null = null;
    if (reveal && row.authorization_id) {
      const a = this.s.auths.get(row.authorization_id);
      token = a ? this.s.auths.accessToken(a) : null;
    }
    return this.curl(
      row.method,
      row.url,
      headers.map(([k, v]) => (k.toLowerCase() === 'authorization' && /^bearer/i.test(v) ? [k, `Bearer ${token ?? '$ZOOM_ACCESS_TOKEN'}`] : [k, v])),
      row.req_body,
      !token,
    );
  }

  async curlForInput(input: SendInput, reveal: boolean): Promise<{ curl: string; warnings: string[] }> {
    const prep = await this.prepare(input, { withToken: reveal });
    const headers = Object.entries(prep.headers).filter(([k]) => k.toLowerCase() !== 'authorization');
    if (input.auth === 'profile') headers.unshift(['Authorization', `Bearer ${prep.accessToken ?? '$ZOOM_ACCESS_TOKEN'}`]);
    return { curl: this.curl(prep.method, prep.url, headers, prep.body, !prep.accessToken), warnings: prep.warnings };
  }

  private curl(method: string, url: string, headers: [string, string][], body: string | null, tokenAsVar: boolean): string {
    const parts = [`curl -sS -X ${method} ${shq(url)}`];
    for (const [k, v] of headers) {
      // Keep $ZOOM_ACCESS_TOKEN expandable by the shell: use double quotes for that one header.
      if (tokenAsVar && /\$ZOOM_ACCESS_TOKEN/.test(v)) parts.push(`-H "${k}: ${v}"`);
      else parts.push(`-H ${shq(`${k}: ${v}`)}`);
    }
    if (body != null && body !== '') parts.push(`--data-raw ${shq(body)}`);
    return parts.join(' \\\n  ');
  }
}
