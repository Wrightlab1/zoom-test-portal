import type { Ctx } from '../context.js';
import type { ProfileRow } from '../db/profiles.js';
import type { TokenSet } from '../db/authorizations.js';
import { sendOutbound } from '../lib/outbound.js';
import { parseZoomError, type CallLogger } from './callLog.js';
import type { ProfilesRepo } from '../db/profiles.js';

export interface TokenCallResult {
  ok: boolean;
  status: number | null;
  tokens?: TokenSet;
  raw?: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  callId: number;
}

/**
 * Thin client for Zoom's OAuth endpoints. Every call is logged in the `token` category with
 * credentials, codes, verifiers and tokens redacted.
 */
export class ZoomOAuthClient {
  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private log: CallLogger,
  ) {}

  oauthBase(): string {
    return this.ctx.settings.get().oauthBaseUrl.replace(/\/+$/, '');
  }

  authorizeUrl(params: Record<string, string>): string {
    const u = new URL(this.oauthBase() + '/oauth/authorize');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private basic(p: ProfileRow): string {
    const secret = this.profiles.clientSecret(p);
    if (!secret) throw new OAuthConfigError('This profile has no client secret set.');
    return 'Basic ' + Buffer.from(`${p.client_id}:${secret}`).toString('base64');
  }

  private async post(
    p: ProfileRow,
    path: '/oauth/token' | '/oauth/revoke',
    form: Record<string, string>,
    meta: { authorizationId: number | null; grantType: string },
  ): Promise<{ status: number | null; json: Record<string, unknown> | null; callId: number; error?: string }> {
    const url = this.oauthBase() + path;
    const body = new URLSearchParams(form).toString();
    const headers = { Authorization: this.basic(p), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const res = await sendOutbound({ method: 'POST', url, headers, body, timeoutMs: 30_000, maxRedirects: 0 }, this.ctx.settings.get().allowlist);
    const call = this.log.log({
      category: 'token',
      profileId: p.id,
      authorizationId: meta.authorizationId,
      authType: p.type,
      grantType: meta.grantType,
      method: 'POST',
      url,
      endpoint: path,
      reqHeaders: headers,
      reqBody: body,
      result: res,
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = res.body.length ? JSON.parse(res.body.toString('utf8')) : null;
    } catch {
      json = null;
    }
    return { status: res.status ?? null, json, callId: call.id, error: res.error };
  }

  async token(p: ProfileRow, form: Record<string, string>, authorizationId: number | null = null): Promise<TokenCallResult> {
    const r = await this.post(p, '/oauth/token', form, { authorizationId, grantType: form.grant_type });
    const j = r.json ?? {};
    if (r.status === 200 && typeof j.access_token === 'string') {
      return {
        ok: true,
        status: r.status,
        raw: j,
        tokens: {
          accessToken: j.access_token,
          refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null,
          expiresIn: Number(j.expires_in ?? 3600),
          scope: typeof j.scope === 'string' ? j.scope : null,
          apiUrl: typeof j.api_url === 'string' ? j.api_url : null,
        },
        errorCode: null,
        errorMessage: null,
        callId: r.callId,
      };
    }
    const zerr = parseZoomError(r.json ? JSON.stringify(r.json) : null);
    return {
      ok: false,
      status: r.status,
      raw: j,
      errorCode: zerr.code,
      errorMessage: r.error ?? zerr.message ?? (r.status ? `HTTP ${r.status}` : 'No response'),
      callId: r.callId,
    };
  }

  async revoke(p: ProfileRow, token: string, authorizationId: number | null): Promise<TokenCallResult> {
    const r = await this.post(p, '/oauth/revoke', { token }, { authorizationId, grantType: 'revoke' });
    const zerr = parseZoomError(r.json ? JSON.stringify(r.json) : null);
    const ok = r.status === 200 && (r.json?.status === 'success' || r.json == null);
    return { ok, status: r.status, raw: r.json ?? {}, errorCode: ok ? null : zerr.code, errorMessage: ok ? null : (r.error ?? zerr.message), callId: r.callId };
  }
}

export class OAuthConfigError extends Error {}
