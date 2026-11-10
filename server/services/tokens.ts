import crypto from 'node:crypto';
import type { Ctx } from '../context.js';
import type { AuthorizationRow, AuthorizationsRepo } from '../db/authorizations.js';
import type { ProfileRow, ProfilesRepo } from '../db/profiles.js';
import type { ZoomOAuthClient } from './oauthClient.js';

/** Serializes async work per key within this process. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Errors after which the refresh token can never work again: the user must re-consent. */
const DEAD_REFRESH_CODES = new Set(['4711', '4735', '4737', '4738', '4740', '4741', 'invalid_grant', 'invalid_token']);
function refreshTokenIsDead(status: number | null, code: string | null, message: string | null): boolean {
  if (status == null || status >= 500) return false;
  if (code && DEAD_REFRESH_CODES.has(code)) return true;
  // Zoom answers a stale/rotated refresh token with 400 {"reason":"Invalid Token!","error":"invalid_request"}.
  if ((status === 400 || status === 401) && /invalid token|revoked|expired|does not exist/i.test(message ?? '')) return true;
  return false;
}

const LEASE_OWNER = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const LEASE_TTL_MS = 45_000;

export class TokenService {
  private mutex = new KeyedMutex();

  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private auths: AuthorizationsRepo,
    private oauth: ZoomOAuthClient,
  ) {}

  private notify(profileId: number, authorizationId: number | null, kind: string) {
    this.ctx.bus.emit('token', { profileId, authorizationId, kind });
  }

  private event(p: ProfileRow, authId: number | null, kind: string, e: Partial<{ grant: string; status: number | null; code: string | null; message: string | null; detail: string; callId: number }>) {
    this.auths.addEvent({
      profile_id: p.id,
      authorization_id: authId,
      kind,
      grant_type: e.grant ?? null,
      http_status: e.status ?? null,
      error_code: e.code ?? null,
      error_message: e.message ?? null,
      detail: e.detail ?? null,
      api_call_id: e.callId ?? null,
    });
    this.notify(p.id, authId, kind);
  }

  requireProfile(id: number): ProfileRow {
    const p = this.profiles.get(id);
    if (!p) throw new TokenError('Profile not found', 'not_found', 404);
    return p;
  }

  // ---------------------------------------------------------------- Server-to-Server

  /** Get a cached S2S token, or request a new one (account_credentials grant). */
  async s2sToken(profileId: number, opts: { force?: boolean; minValidityMs?: number } = {}): Promise<{ row: AuthorizationRow; accessToken: string }> {
    const p = this.requireProfile(profileId);
    if (p.type !== 's2s') throw new TokenError('Not a Server-to-Server profile', 'wrong_type', 400);
    return this.mutex.run(`s2s:${p.id}`, async () => {
      const existing = this.auths.s2sFor(p.id);
      const min = opts.minValidityMs ?? 60_000;
      if (!opts.force && existing && existing.status === 'active' && existing.access_expires_at && existing.access_expires_at - Date.now() > min) {
        const at = this.auths.accessToken(existing);
        if (at) return { row: existing, accessToken: at };
      }
      if (!p.account_id) throw new TokenError('This Server-to-Server profile has no Account ID.', 'config', 400);
      const r = await this.oauth.token(p, { grant_type: 'account_credentials', account_id: p.account_id }, existing?.id ?? null);
      if (!r.ok || !r.tokens) {
        if (existing && existing.status === 'active' && !(existing.access_expires_at && existing.access_expires_at > Date.now())) {
          this.auths.setStatus(existing.id, 'failed', r.errorMessage);
        }
        this.event(p, existing?.id ?? null, 'failed', { grant: 'account_credentials', status: r.status, code: r.errorCode, message: r.errorMessage, callId: r.callId });
        throw new TokenError(`Token request failed: ${r.errorMessage}`, r.errorCode, r.status);
      }
      let row: AuthorizationRow;
      if (existing && existing.status !== 'superseded') {
        this.auths.storeTokens(existing.id, existing.version, r.tokens, 'reissue');
        row = this.auths.get(existing.id)!;
      } else {
        row = this.auths.insert({ profileId: p.id, kind: 's2s', tokens: r.tokens, zoomAccountId: p.account_id });
      }
      this.event(p, row.id, 'issued', { grant: 'account_credentials', status: r.status, callId: r.callId, detail: `expires_in=${r.tokens.expiresIn}` });
      return { row, accessToken: r.tokens.accessToken };
    });
  }

  // ---------------------------------------------------------------- User OAuth refresh

  /**
   * Refresh a user authorization. Concurrent callers are serialized per authorization; a caller
   * that passes `ifVersion` gets the already-refreshed tokens if someone else refreshed first,
   * so a burst of 401s results in exactly one refresh.
   */
  async refreshUser(authId: number, opts: { force?: boolean; ifVersion?: number; reason?: string } = {}): Promise<AuthorizationRow> {
    return this.mutex.run(`auth:${authId}`, async () => {
      let row = this.auths.get(authId);
      if (!row) throw new TokenError('Authorization not found', 'not_found', 404);
      if (row.kind !== 'user') throw new TokenError('Not a user authorization', 'wrong_type', 400);
      const p = this.requireProfile(row.profile_id);

      if (opts.ifVersion !== undefined && row.version > opts.ifVersion) return row; // someone else already refreshed
      if (!opts.force && row.access_expires_at && row.access_expires_at - Date.now() > this.ctx.settings.get().refreshLeadSec * 1000) return row;
      if (row.status === 'revoked' || row.status === 'superseded') {
        throw new TokenError(`Authorization is ${row.status}; authorize again.`, row.status, 409);
      }

      // Cross-process guard: if another process holds the lease, wait for it to finish.
      if (!this.auths.acquireLease(row.id, LEASE_OWNER, LEASE_TTL_MS)) {
        const startVersion = row.version;
        const deadline = Date.now() + LEASE_TTL_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          row = this.auths.get(authId)!;
          if (row.version > startVersion) return row;
          if (this.auths.acquireLease(row.id, LEASE_OWNER, LEASE_TTL_MS)) break;
        }
        row = this.auths.get(authId)!;
      }

      try {
        const rt = this.auths.refreshToken(row);
        if (!rt) throw new TokenError('No refresh token stored; authorize again.', 'no_refresh_token', 409);
        const r = await this.oauth.token(p, { grant_type: 'refresh_token', refresh_token: rt }, row.id);
        if (!r.ok || !r.tokens) {
          const dead = refreshTokenIsDead(r.status, r.errorCode, r.errorMessage);
          if (dead) this.auths.setStatus(row.id, 'failed', `Refresh rejected: ${r.errorMessage}`);
          this.event(p, row.id, 'failed', {
            grant: 'refresh_token',
            status: r.status,
            code: r.errorCode,
            message: r.errorMessage,
            callId: r.callId,
            detail: dead ? 'Refresh token rejected; re-authorization required.' : opts.reason,
          });
          throw new TokenError(`Refresh failed: ${r.errorMessage}`, r.errorCode, r.status);
        }
        if (!r.tokens.refreshToken) {
          // Zoom always rotates; keep the old one only as a last resort and record it.
          this.event(p, row.id, 'warning', { grant: 'refresh_token', detail: 'Refresh response had no refresh_token; kept the previous one.' });
        }
        // Atomic write of the new pair, guarded by version.
        if (!this.auths.storeTokens(row.id, row.version, r.tokens, 'refresh')) {
          // Should be impossible while we hold both the mutex and the lease.
          this.event(p, row.id, 'warning', { detail: 'Version moved during refresh; new tokens were not stored.' });
          throw new TokenError('Concurrent modification during refresh', 'conflict', 409);
        }
        const updated = this.auths.get(row.id)!;
        this.event(p, row.id, 'refreshed', { grant: 'refresh_token', status: r.status, callId: r.callId, detail: opts.reason });
        return updated;
      } finally {
        this.auths.releaseLease(row.id, LEASE_OWNER);
      }
    });
  }

  /** Return a usable access token for an authorization, refreshing or re-requesting if near expiry. */
  async accessTokenFor(authId: number, opts: { minValidityMs?: number } = {}): Promise<{ row: AuthorizationRow; accessToken: string }> {
    const row = this.auths.get(authId);
    if (!row) throw new TokenError('Authorization not found', 'not_found', 404);
    if (row.kind === 's2s') return this.s2sToken(row.profile_id, { minValidityMs: opts.minValidityMs });
    if (row.status !== 'active') throw new TokenError(`Authorization is ${row.status}${row.status_detail ? `: ${row.status_detail}` : ''}`, row.status, 409);
    const min = opts.minValidityMs ?? 60_000;
    let current = row;
    if (!row.access_expires_at || row.access_expires_at - Date.now() < min) {
      current = await this.refreshUser(authId, { force: true, ifVersion: row.version, reason: 'expiring before use' });
    }
    const at = this.auths.accessToken(current);
    if (!at) throw new TokenError('No access token stored', 'no_token', 409);
    return { row: current, accessToken: at };
  }

  /** Called after a 401 "expired" response: refresh (or re-request) once, coalescing with other callers. */
  async renewAfterExpiry(row: AuthorizationRow): Promise<{ row: AuthorizationRow; accessToken: string }> {
    if (row.kind === 's2s') {
      // Only re-request if nobody already did since this token was used.
      const cur = this.auths.get(row.id);
      if (cur && cur.version > row.version && cur.status === 'active') {
        const at = this.auths.accessToken(cur);
        if (at) return { row: cur, accessToken: at };
      }
      return this.s2sToken(row.profile_id, { force: true });
    }
    const updated = await this.refreshUser(row.id, { force: true, ifVersion: row.version, reason: '401 access token expired' });
    const at = this.auths.accessToken(updated);
    if (!at) throw new TokenError('No access token after refresh', 'no_token', 409);
    return { row: updated, accessToken: at };
  }

  // ---------------------------------------------------------------- Revoke / reveal

  async revoke(authId: number): Promise<AuthorizationRow> {
    return this.mutex.run(`auth:${authId}`, async () => {
      const row = this.auths.get(authId);
      if (!row) throw new TokenError('Authorization not found', 'not_found', 404);
      const p = this.requireProfile(row.profile_id);
      const token = this.auths.accessToken(row) ?? this.auths.refreshToken(row);
      if (!token) {
        this.auths.setStatus(row.id, 'revoked', 'No token to revoke', true);
        return this.auths.get(row.id)!;
      }
      const r = await this.oauth.revoke(p, token, row.id);
      if (!r.ok) {
        this.event(p, row.id, 'failed', { grant: 'revoke', status: r.status, code: r.errorCode, message: r.errorMessage, callId: r.callId });
        throw new TokenError(`Revoke failed: ${r.errorMessage}`, r.errorCode, r.status);
      }
      this.auths.setStatus(row.id, 'revoked', 'Revoked from portal', true);
      this.event(p, row.id, 'revoked', { grant: 'revoke', status: r.status, callId: r.callId });
      return this.auths.get(row.id)!;
    });
  }

  reveal(authId: number, field: 'access_token' | 'refresh_token'): string | null {
    const row = this.auths.get(authId);
    if (!row) throw new TokenError('Authorization not found', 'not_found', 404);
    return field === 'access_token' ? this.auths.accessToken(row) : this.auths.refreshToken(row);
  }

  // ---------------------------------------------------------------- Scheduler

  /** Refresh user tokens / re-request S2S tokens that are inside the lead window. */
  private backoff = new Map<number, { failures: number; next: number }>();

  async tick(): Promise<void> {
    const lead = this.ctx.settings.get().refreshLeadSec * 1000;
    const now = Date.now();
    for (const row of this.auths.listRefreshable()) {
      if (!row.access_expires_at || row.access_expires_at - now > lead) continue;
      const b = this.backoff.get(row.id);
      if (b && b.next > now) continue;
      try {
        if (row.kind === 's2s') await this.s2sToken(row.profile_id, { minValidityMs: lead });
        else await this.refreshUser(row.id, { reason: 'scheduled' });
        this.backoff.delete(row.id);
      } catch {
        // Recorded as a token event. Back off so a persistent failure doesn't spam Zoom.
        const failures = (b?.failures ?? 0) + 1;
        this.backoff.set(row.id, { failures, next: now + Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1)) });
      }
    }
  }
}
