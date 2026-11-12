import crypto from 'node:crypto';
import type { Ctx } from '../context.js';
import type { ProfileRow, ProfilesRepo } from '../db/profiles.js';
import type { AuthorizationRow, AuthorizationsRepo } from '../db/authorizations.js';
import { aad } from '../db/index.js';
import { randomToken, sha256hex } from '../lib/crypto.js';
import type { ZoomOAuthClient } from './oauthClient.js';
import type { PublicUrls } from './publicUrls.js';
import type { CallLogger } from './callLog.js';
import { sendOutbound } from '../lib/outbound.js';
import { TokenError } from './tokens.js';
import type { BulkAuthService } from './bulkAuth.js';

const STATE_TTL_MS = 10 * 60_000;
const A_VERIFIER = aad('oauth_pending', 'verifier_enc');

interface PendingRow {
  state_hash: string;
  profile_id: number;
  verifier_enc: string | null;
  redirect_uri: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface CallbackOutcome {
  status: number;
  title: string;
  message: string;
  ok: boolean;
  authorizationId?: number;
}

/**
 * Authorization code flow for General (user OAuth) apps.
 *
 * The callback arrives on the public listener (ngrok host), where the admin session cookie is
 * not available, so the pending authorization is bound server-side to a hash of `state`:
 * single use, 10 minute expiry, holding the PKCE verifier and the exact redirect URI used.
 */
export class UserOAuthService {
  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private auths: AuthorizationsRepo,
    private oauth: ZoomOAuthClient,
    private publicUrls: PublicUrls,
    private callLog: CallLogger,
    private bulk: BulkAuthService,
  ) {}

  private event(profileId: number, authId: number | null, kind: string, e: { status?: number | null; code?: string | null; message?: string | null; detail?: string; callId?: number; grant?: string } = {}) {
    this.auths.addEvent({
      profile_id: profileId,
      authorization_id: authId,
      kind,
      grant_type: e.grant ?? 'authorization_code',
      http_status: e.status ?? null,
      error_code: e.code ?? null,
      error_message: e.message ?? null,
      detail: e.detail ?? null,
      api_call_id: e.callId ?? null,
    });
    this.ctx.bus.emit('token', { profileId, authorizationId: authId, kind });
  }

  start(profileId: number, opts: { scope?: string } = {}): { authorizeUrl: string; redirectUri: string; expiresAt: number; pkce: boolean } {
    const p = this.profiles.get(profileId);
    if (!p) throw new TokenError('Profile not found', 'not_found', 404);
    if (p.type !== 'user') throw new TokenError('Authorize is only for user OAuth profiles', 'wrong_type', 400);
    if (!this.profiles.clientSecret(p)) throw new TokenError('Set the client secret before authorizing', 'config', 400);
    const urls = this.publicUrls.forProfile(p.slug);
    if (!urls) throw new TokenError('No public URL yet. Start the ngrok tunnel (or set a public base URL) first.', 'no_public_url', 409);

    const now = Date.now();
    this.ctx.db.prepare('DELETE FROM oauth_pending WHERE expires_at < ? OR consumed_at IS NOT NULL AND consumed_at < ?').run(now, now - 3600_000);

    const state = randomToken(32);
    const params: Record<string, string> = { response_type: 'code', client_id: p.client_id, redirect_uri: urls.redirectUri, state };
    let verifier: string | null = null;
    if (p.use_pkce) {
      verifier = randomToken(48); // 64 chars, within RFC 7636's 43–128
      params.code_challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      params.code_challenge_method = 'S256';
    }
    const scope = opts.scope ?? p.scopes_requested ?? '';
    if (scope.trim()) params.scope = scope.trim();

    this.ctx.db
      .prepare('INSERT INTO oauth_pending (state_hash, profile_id, verifier_enc, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256hex(state), p.id, this.ctx.cipher.encNullable(verifier, A_VERIFIER), urls.redirectUri, now, now + STATE_TTL_MS);
    this.event(p.id, null, 'authorize_started', { detail: `redirect_uri=${urls.redirectUri}${verifier ? ' pkce=S256' : ''}` });
    return { authorizeUrl: this.oauth.authorizeUrl(params), redirectUri: urls.redirectUri, expiresAt: now + STATE_TTL_MS, pkce: !!verifier };
  }

  /** Atomically consume a pending state. Returns null if unknown, expired or already used. */
  private consume(state: string): PendingRow | null {
    const row = this.ctx.db
      .prepare('UPDATE oauth_pending SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *')
      .get(Date.now(), sha256hex(state), Date.now()) as PendingRow | undefined;
    return row ?? null;
  }

  async callback(slug: string, q: Record<string, string | undefined>): Promise<CallbackOutcome> {
    const p = this.profiles.getBySlug(slug);
    if (!p || p.type !== 'user') return { ok: false, status: 404, title: 'Unknown app', message: 'No user OAuth profile matches this callback URL.' };

    if (q.error) {
      if (q.state) this.consume(q.state);
      this.event(p.id, null, 'failed', { code: q.error, message: q.error_description ?? q.error, detail: 'Zoom returned an error to the redirect URI' });
      return { ok: false, status: 400, title: 'Authorization was not granted', message: `Zoom returned: ${q.error}${q.error_description ? ` — ${q.error_description}` : ''}` };
    }
    const paramNames = Object.keys(q).filter((k) => q[k] !== undefined);
    if (!q.code) {
      if (q.state) this.consume(q.state);
      this.event(p.id, null, 'failed', { code: 'missing_code', detail: `Callback without code (query parameters present: ${paramNames.join(', ') || 'none'})` });
      return { ok: false, status: 400, title: 'Invalid callback', message: 'Zoom redirected here without an authorization code.' };
    }

    // Admin authorization for users and groups: Zoom adds code_type=bulk and the code must be
    // exchanged for a bulk access token instead of a single user's tokens.
    const bulk = (q.code_type ?? '').toLowerCase() === 'bulk';

    let redirectUri: string;
    let verifier: string | null = null;
    let origin: 'portal' | 'marketplace';
    if (q.state) {
      const pending = this.consume(q.state);
      if (!pending) {
        this.event(p.id, null, 'failed', { code: 'invalid_state', detail: 'Unknown, expired or already-used state — possible replay or stale tab.' });
        return { ok: false, status: 400, title: 'Invalid or expired state', message: 'This authorization link was already used or has expired. Start again from the portal.' };
      }
      if (pending.profile_id !== p.id) {
        this.event(p.id, null, 'failed', { code: 'state_mismatch', detail: 'State belongs to a different profile.' });
        return { ok: false, status: 400, title: 'State mismatch', message: 'This state was issued for a different profile.' };
      }
      redirectUri = pending.redirect_uri;
      verifier = this.ctx.cipher.decNullable(pending.verifier_enc, A_VERIFIER);
      origin = 'portal';
    } else {
      // A code without state means consent started on Zoom's side (Marketplace "Add" / "Local Test" /
      // the app's authorization URL), not from the portal's Authorize button. Accepting it skips the
      // login-CSRF protection that state provides, so it is an explicit per-profile opt-in.
      if (!p.accept_marketplace_installs) {
        this.event(p.id, null, 'failed', {
          code: 'no_state',
          detail: bulk
            ? 'Zoom redirected with code_type=bulk (an admin used "Add for others" → users and groups) and no state. Rejected; enable "Accept installs started from the Zoom Marketplace" on the profile to allow this.'
            : 'Zoom redirected with a code but no state: consent was started from the Zoom Marketplace (Add / Local Test / authorization URL), not from the portal. Rejected; enable "Accept installs started from the Zoom Marketplace" on the profile to allow this.',
        });
        return {
          ok: false,
          status: 400,
          title: bulk ? 'Admin authorization rejected' : 'Authorization started outside the portal',
          message: bulk
            ? 'An admin authorized this app for users and groups (code_type=bulk). That always starts in the Zoom Marketplace and carries no state value, and this profile does not accept Marketplace-initiated installs. Edit the profile, enable "Accept installs started from the Zoom Marketplace", then authorize for users and groups again.'
            : 'This consent came from the Zoom Marketplace (Add / Local Test), which does not include the portal\'s state value, so it was rejected. Either click "Authorize…" on the profile in the portal, or edit the profile, enable "Accept installs started from the Zoom Marketplace", and add the app again.',
        };
      }
      const urls = this.publicUrls.forProfile(p.slug);
      if (!urls) return { ok: false, status: 409, title: 'No public URL', message: 'The portal has no public URL configured, so it cannot rebuild the redirect URI.' };
      redirectUri = urls.redirectUri;
      origin = 'marketplace';
    }

    const form: Record<string, string> = { grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri };
    if (verifier) form.code_verifier = verifier;

    if (bulk) {
      const b = await this.bulk.exchangeCode(p, form, origin);
      if (!b.ok) return { ok: false, status: 502, title: 'Bulk token exchange failed', message: `Zoom said: ${b.errorMessage ?? 'unknown error'}` };
      const delay = this.ctx.settings.get().bulkFirstFetchDelaySec;
      return {
        ok: true,
        status: 200,
        title: 'Admin authorization received',
        message: `Zoom issued a bulk access token (grant #${b.grant.id}). The portal will exchange it for each user's tokens ${delay ? `in about ${delay} seconds` : 'now'}, then page through until Zoom reports no more. Progress appears on the profile page.`,
      };
    }
    const r = await this.oauth.token(p, form, null);
    if (!r.ok || !r.tokens) {
      this.event(p.id, null, 'failed', { status: r.status, code: r.errorCode, message: r.errorMessage, callId: r.callId, detail: `Code exchange failed (${origin === 'marketplace' ? 'Marketplace-initiated, no state' : 'started from portal'})` });
      return { ok: false, status: 502, title: 'Token exchange failed', message: `Zoom said: ${r.errorMessage ?? 'unknown error'}` };
    }

    const me = await this.whoAmI(p, r.tokens.accessToken, r.tokens.apiUrl ?? null);
    const row = this.ctx.db.transaction(() => {
      if (me.id) {
        for (const old of this.auths.activeForZoomUser(p.id, { id: me.id, email: me.email })) {
          const where = old.profile_id === p.id ? '' : ` via profile "${p.name}"`;
          this.auths.setStatus(old.id, 'superseded', `Same Zoom user re-authorized this app${where}; Zoom invalidates the previous tokens (4741).`, true);
          this.event(old.profile_id, old.id, 'superseded', { detail: `Replaced by a new authorization for the same Zoom user${where}` });
        }
      }
      return this.auths.insert({
        profileId: p.id,
        kind: 'user',
        tokens: r.tokens!,
        usedPkce: !!verifier,
        zoomUserId: me.id,
        zoomEmail: me.email,
        zoomName: me.name,
        zoomAccountId: me.accountId,
      });
    })();
    this.event(p.id, row.id, 'issued', { status: r.status, callId: r.callId, detail: `${me.id ? `as ${me.email ?? me.id}` : `user lookup failed: ${me.error}`}${origin === 'marketplace' ? ' — Marketplace-initiated (no state)' : ''}` });
    return {
      ok: true,
      status: 200,
      title: 'Authorized',
      message: me.id ? `Authorized as ${me.name ?? ''} ${me.email ? `<${me.email}>` : ''}`.trim() : `Authorized, but /v2/users/me failed (${me.error}).`,
      authorizationId: row.id,
    };
  }

  /** Label the authorization with the Zoom user it belongs to. Logged like any API call. */
  private async whoAmI(p: ProfileRow, accessToken: string, apiUrl: string | null) {
    const base = (apiUrl ?? this.ctx.settings.get().apiBaseUrl).replace(/\/+$/, '');
    const url = `${base}/v2/users/me`;
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const res = await sendOutbound({ method: 'GET', url, headers, timeoutMs: 20_000 }, this.ctx.settings.get().allowlist);
    this.callLog.log({ category: 'api', profileId: p.id, authorizationId: null, authType: 'user', method: 'GET', url, endpoint: '/users/me', reqHeaders: headers, reqBody: null, result: res });
    if (res.status !== 200) return { id: null, email: null, name: null, accountId: null, error: res.error ?? `HTTP ${res.status}` };
    try {
      const j = JSON.parse(res.body.toString('utf8'));
      const name = j.display_name ?? ([j.first_name, j.last_name].filter(Boolean).join(' ') || null);
      return { id: j.id ? String(j.id) : null, email: j.email ?? null, name, accountId: j.account_id ?? null, error: null };
    } catch {
      return { id: null, email: null, name: null, accountId: null, error: 'unparseable response' };
    }
  }

  /** Re-fetch /users/me to relabel an authorization. */
  async relabel(row: AuthorizationRow, accessToken: string) {
    const p = this.profiles.get(row.profile_id)!;
    const me = await this.whoAmI(p, accessToken, row.api_url);
    if (me.id) this.auths.updateIdentity(row.id, { zoomUserId: me.id, zoomEmail: me.email, zoomName: me.name, zoomAccountId: me.accountId });
    return me;
  }
}
