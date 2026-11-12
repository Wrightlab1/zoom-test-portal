import type { Ctx } from '../context.js';
import type { ProfileRow, ProfilesRepo } from '../db/profiles.js';
import type { AuthorizationsRepo, TokenSet } from '../db/authorizations.js';
import type { BulkGrantRow, BulkGrantsRepo } from '../db/bulkGrants.js';
import type { ZoomOAuthClient } from './oauthClient.js';
import { KeyedMutex, TokenError } from './tokens.js';
import { secrets } from '../lib/redact.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const BULK_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:bulk_access_token';

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Hard stop on pages per run, in case a server keeps answering has_more=true. */
const MAX_PAGES_PER_RUN = 1000;

interface ExchangeItem {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  email?: string;
}

/**
 * Admin authorization for users and groups
 * (https://developers.zoom.us/docs/integrations/admin-auth-for-users-and-groups/).
 *
 * 1. Zoom redirects to the redirect URL with `code` and `code_type=bulk`.
 * 2. The code is exchanged (grant_type=authorization_code) for a single *bulk access token*.
 *    That token is not a user token and is never used against the REST API.
 * 3. The bulk token is exchanged (RFC 8693 token exchange) for per-user tokens, in pages of
 *    `batch_size`, repeating with the same token and batch_size while `has_more` is true.
 *    Zoom prepares user tokens asynchronously, so the first attempt waits and failures retry.
 * Each user token becomes an ordinary user authorization (refresh, reveal, revoke as usual).
 */
export class BulkAuthService {
  private mutex = new KeyedMutex();
  private running = new Set<number>();
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private auths: AuthorizationsRepo,
    private grants: BulkGrantsRepo,
    private oauth: ZoomOAuthClient,
  ) {}

  private event(profileId: number, kind: string, e: { grant?: string; status?: number | null; code?: string | null; message?: string | null; detail?: string; callId?: number; authId?: number | null } = {}) {
    this.auths.addEvent({
      profile_id: profileId,
      authorization_id: e.authId ?? null,
      kind,
      grant_type: e.grant ?? TOKEN_EXCHANGE_GRANT,
      http_status: e.status ?? null,
      error_code: e.code ?? null,
      error_message: e.message ?? null,
      detail: e.detail ?? null,
      api_call_id: e.callId ?? null,
    });
    this.ctx.bus.emit('token', { profileId, authorizationId: e.authId ?? null, kind });
  }

  /** Step 2: exchange a `code_type=bulk` code for the bulk access token and schedule retrieval. */
  async exchangeCode(p: ProfileRow, form: Record<string, string>, origin: 'portal' | 'marketplace') {
    const r = await this.oauth.token(p, form, null);
    if (!r.ok || !r.tokens) {
      this.event(p.id, 'failed', { grant: 'authorization_code', status: r.status, code: r.errorCode, message: r.errorMessage, callId: r.callId, detail: 'Bulk (admin) code exchange failed' });
      return { ok: false as const, errorMessage: r.errorMessage };
    }
    const tokenType = typeof r.raw?.token_type === 'string' ? r.raw.token_type : null;
    const st = this.ctx.settings.get();
    const firstAt = Date.now() + st.bulkFirstFetchDelaySec * 1000;
    const g = this.grants.insert({ profileId: p.id, token: r.tokens.accessToken, tokenType, expiresIn: r.tokens.expiresIn, batchSize: st.bulkBatchSize, firstAttemptAt: firstAt, origin });
    if (r.tokens.refreshToken) secrets.add(r.tokens.refreshToken); // not expected for a bulk token; keep it out of logs anyway
    this.event(p.id, 'bulk_issued', {
      grant: 'authorization_code',
      status: r.status,
      callId: r.callId,
      detail: `Bulk grant #${g.id}: token_type=${tokenType ?? '(none)'}, expires_in=${r.tokens.expiresIn}s. User tokens will be requested ${st.bulkFirstFetchDelaySec ? `in ${st.bulkFirstFetchDelaySec}s` : 'now'} (batch_size=${st.bulkBatchSize}).${tokenType && tokenType !== 'bulk_access_token' ? ' Unexpected token_type.' : ''}`,
    });
    this.schedule(g.id, firstAt);
    return { ok: true as const, grant: g };
  }

  /** Run (or queue) retrieval at a given time within this process; tick() covers restarts. */
  private schedule(id: number, at: number) {
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.run(id).catch(() => {});
    }, Math.max(0, at - Date.now()));
    t.unref();
    this.timers.set(id, t);
  }

  /** Called by the scheduler: pick up due grants (first attempts, retries, interrupted runs). */
  async tick(): Promise<void> {
    for (const g of this.grants.due(Date.now())) {
      if (this.running.has(g.id) || this.timers.has(g.id)) continue;
      await this.run(g.id).catch(() => {});
    }
  }

  /**
   * Step 3: retrieve user tokens page by page until has_more is false.
   * `manual` restarts a finished grant (a new pass over the same bulk token).
   */
  async run(id: number, opts: { manual?: boolean } = {}): Promise<BulkGrantRow> {
    return this.mutex.run(`bulk:${id}`, async () => {
      let g = this.grants.get(id);
      if (!g) throw new TokenError('Bulk grant not found', 'not_found', 404);
      const p = this.profiles.get(g.profile_id);
      if (!p) throw new TokenError('Profile not found', 'not_found', 404);
      if (!opts.manual && g.status !== 'waiting' && g.status !== 'fetching') return g;
      const token = this.grants.bulkToken(g);
      if (!token || (g.expires_at != null && g.expires_at <= Date.now())) {
        this.expire(g, p);
        if (opts.manual) throw new TokenError('The bulk access token has expired. Ask the admin to authorize for users and groups again.', 'expired', 409);
        return this.grants.get(id)!;
      }
      const t = this.timers.get(id);
      if (t) {
        clearTimeout(t);
        this.timers.delete(id);
      }

      this.running.add(id);
      try {
        const restart = opts.manual && (g.status === 'complete' || g.status === 'failed');
        this.grants.update(id, {
          status: 'fetching',
          next_attempt_at: null,
          ...(restart ? { pages: 0, users_received: 0, completed_at: null, status_detail: 'Manual re-fetch' } : {}),
        });
        let pagesThisRun = 0;
        while (pagesThisRun < MAX_PAGES_PER_RUN) {
          g = this.grants.get(id)!;
          const form: Record<string, string> = {
            grant_type: TOKEN_EXCHANGE_GRANT,
            subject_token: token,
            subject_token_type: BULK_SUBJECT_TOKEN_TYPE,
            batch_size: String(g.batch_size), // must not change within a session
          };
          const r = await this.oauth.tokenRaw(p, form, null);
          const attempts = g.attempts + 1;
          if (!r.ok || !r.json) {
            this.retryLater(g, p, attempts, `HTTP ${r.status ?? '—'}${r.errorCode ? ` ${r.errorCode}` : ''}: ${r.errorMessage ?? 'unknown error'}`, r);
            return this.grants.get(id)!;
          }
          const j = r.json as { api_url?: unknown; items?: unknown; has_more?: unknown };
          if (!Array.isArray(j.items)) {
            this.retryLater(g, p, attempts, 'Response had no items[] array', r);
            return this.grants.get(id)!;
          }
          const apiUrl = typeof j.api_url === 'string' && j.api_url ? j.api_url : null;
          const stored = this.storePage(p, g, j.items as ExchangeItem[], apiUrl);
          const pages = g.pages + 1;
          const users = g.users_received + stored.count;
          pagesThisRun++;
          this.grants.update(id, { attempts, pages, users_received: users, api_url: apiUrl ?? g.api_url, last_error: null });
          const hasMore = j.has_more === true;
          this.event(p.id, 'bulk_page', {
            status: r.status,
            callId: r.callId,
            detail: `Bulk grant #${id} page ${pages}: ${stored.count} user token(s)${stored.skipped ? `, ${stored.skipped} item(s) without access_token skipped` : ''}${stored.superseded ? `, ${stored.superseded} older authorization(s) superseded` : ''}${stored.sample ? ` — ${stored.sample}` : ''}; has_more=${hasMore}`,
          });
          if (!hasMore) {
            const detail = users === 0 ? 'Zoom returned no users. Preparation may still be in progress, or the grant covers nobody yet; use "Fetch again" in a minute.' : null;
            this.grants.update(id, { status: 'complete', status_detail: detail, completed_at: Date.now(), next_attempt_at: null });
            this.event(p.id, users ? 'bulk_complete' : 'warning', { detail: `Bulk grant #${id} complete: ${users} user token(s) in ${pages} page(s).${detail ? ` ${detail}` : ''}` });
            return this.grants.get(id)!;
          }
        }
        this.grants.update(id, { status: 'failed', status_detail: `Stopped after ${MAX_PAGES_PER_RUN} pages in one run (has_more never became false).` });
        return this.grants.get(id)!;
      } finally {
        this.running.delete(id);
      }
    });
  }

  private storePage(p: ProfileRow, g: BulkGrantRow, items: ExchangeItem[], apiUrl: string | null) {
    let count = 0;
    let skipped = 0;
    let superseded = 0;
    const emails: string[] = [];
    this.ctx.db.transaction(() => {
      for (const it of items) {
        if (!it || typeof it.access_token !== 'string' || !it.access_token) {
          skipped++;
          continue;
        }
        const email = typeof it.email === 'string' && it.email ? it.email : null;
        if (email) {
          for (const old of this.auths.activeForZoomUser(p.id, { email })) {
            // Keep the old token values (not cleared): whether Zoom invalidates them on bulk
            // re-issue is not documented. They are hidden as superseded and no longer refreshed.
            this.auths.setStatus(old.id, 'superseded', `Replaced by admin (bulk) grant #${g.id} for the same user${old.profile_id === p.id ? '' : ` via profile "${p.name}"`}.`);
            this.event(old.profile_id, 'superseded', { authId: old.id, detail: `Replaced by bulk grant #${g.id}` });
            superseded++;
          }
        }
        if (typeof it.id_token === 'string') secrets.add(it.id_token);
        const tokens: TokenSet = {
          accessToken: it.access_token,
          refreshToken: typeof it.refresh_token === 'string' && it.refresh_token ? it.refresh_token : null,
          expiresIn: Number.isFinite(Number(it.expires_in)) && Number(it.expires_in) > 0 ? Number(it.expires_in) : 3600,
          scope: typeof it.scope === 'string' ? it.scope : null,
          apiUrl,
        };
        this.auths.insert({ profileId: p.id, kind: 'user', tokens, zoomEmail: email, bulkGrantId: g.id });
        count++;
        if (email && emails.length < 5) emails.push(email);
      }
    })();
    const sample = emails.length ? emails.join(', ') + (count > emails.length ? ` and ${count - emails.length} more` : '') : '';
    return { count, skipped, superseded, sample };
  }

  private retryLater(g: BulkGrantRow, p: ProfileRow, attempts: number, error: string, r: { status: number | null; errorCode: string | null; errorMessage: string | null; callId: number }) {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(10, Math.max(0, attempts - 1)));
    const next = Date.now() + delay;
    const beforeExpiry = g.expires_at == null || next < g.expires_at;
    const page = g.pages + 1;
    if (beforeExpiry) {
      this.grants.update(g.id, { status: 'waiting', attempts, last_error: error, next_attempt_at: next, status_detail: `Page ${page} not retrieved; retrying in ${Math.round(delay / 1000)}s (Zoom prepares user tokens asynchronously).` });
      this.schedule(g.id, next);
    } else {
      this.grants.update(g.id, { status: 'failed', attempts, last_error: error, next_attempt_at: null, status_detail: `Page ${page} not retrieved and the bulk token expires before the next retry.` });
    }
    this.event(p.id, 'failed', { status: r.status, code: r.errorCode, message: r.errorMessage, callId: r.callId, detail: `Bulk grant #${g.id} page ${page}, attempt ${attempts}: ${beforeExpiry ? `retry in ${Math.round(delay / 1000)}s` : 'giving up'}` });
  }

  private expire(g: BulkGrantRow, p: ProfileRow) {
    if (g.status === 'expired') return;
    const wasDone = g.status === 'complete';
    this.grants.update(g.id, { status: wasDone ? 'complete' : 'expired', next_attempt_at: null, status_detail: wasDone ? g.status_detail : 'Bulk access token expired before all user tokens were retrieved.' });
    this.grants.clearToken(g.id);
    if (!wasDone) this.event(p.id, 'failed', { detail: `Bulk grant #${g.id}: bulk access token expired after ${g.users_received} user token(s).` });
  }

  /** Drop expired bulk tokens from storage (called by the scheduler). */
  sweepExpired() {
    const rows = this.ctx.db.prepare('SELECT * FROM bulk_grants WHERE bulk_token_enc IS NOT NULL AND expires_at <= ?').all(Date.now()) as BulkGrantRow[];
    for (const g of rows) {
      const p = this.profiles.get(g.profile_id);
      if (p) this.expire(g, p);
    }
  }

  delete(id: number): boolean {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    return this.grants.delete(id);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
