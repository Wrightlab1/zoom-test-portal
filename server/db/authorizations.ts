import type { DB } from './index.js';
import { aad } from './index.js';
import type { Cipher } from '../lib/crypto.js';
import { mask, secrets } from '../lib/redact.js';

export type AuthStatus = 'active' | 'failed' | 'revoked' | 'superseded';

export interface AuthorizationRow {
  id: number;
  profile_id: number;
  kind: 's2s' | 'user';
  zoom_user_id: string | null;
  zoom_email: string | null;
  zoom_name: string | null;
  zoom_account_id: string | null;
  scopes: string | null;
  api_url: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: number | null;
  issued_at: number | null;
  last_refreshed_at: number | null;
  status: AuthStatus;
  status_detail: string | null;
  used_pkce: number;
  version: number;
  refresh_lease_until: number | null;
  refresh_lease_owner: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuthorizationView {
  id: number;
  profileId: number;
  kind: 's2s' | 'user';
  zoomUserId: string | null;
  zoomEmail: string | null;
  zoomName: string | null;
  zoomAccountId: string | null;
  scopes: string[];
  apiUrl: string | null;
  accessTokenHint: string | null;
  refreshTokenHint: string | null;
  accessExpiresAt: number | null;
  issuedAt: number | null;
  lastRefreshedAt: number | null;
  status: AuthStatus;
  statusDetail: string | null;
  usedPkce: boolean;
  version: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn: number;
  scope?: string | null;
  apiUrl?: string | null;
}

export interface TokenEventRow {
  id: number;
  profile_id: number | null;
  authorization_id: number | null;
  at: number;
  kind: string;
  grant_type: string | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  detail: string | null;
  api_call_id: number | null;
}

const A_ACCESS = aad('authorizations', 'access_token_enc');
const A_REFRESH = aad('authorizations', 'refresh_token_enc');

export class AuthorizationsRepo {
  constructor(
    private db: DB,
    private cipher: Cipher,
  ) {}

  registerSecrets(): void {
    for (const r of this.db
      .prepare("SELECT access_token_enc, refresh_token_enc FROM authorizations WHERE status IN ('active','failed')")
      .all() as AuthorizationRow[]) {
      secrets.add(this.cipher.decNullable(r.access_token_enc, A_ACCESS));
      secrets.add(this.cipher.decNullable(r.refresh_token_enc, A_REFRESH));
    }
  }

  get(id: number): AuthorizationRow | null {
    return (this.db.prepare('SELECT * FROM authorizations WHERE id = ?').get(id) as AuthorizationRow | undefined) ?? null;
  }
  listForProfile(profileId: number, includeSuperseded = true): AuthorizationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM authorizations WHERE profile_id = ? ${includeSuperseded ? '' : "AND status != 'superseded'"} ORDER BY status = 'active' DESC, updated_at DESC`,
      )
      .all(profileId) as AuthorizationRow[];
  }
  /** All rows the refresh scheduler might care about. */
  listRefreshable(): AuthorizationRow[] {
    return this.db
      .prepare(
        `SELECT a.* FROM authorizations a JOIN profiles p ON p.id = a.profile_id
         WHERE a.status = 'active' AND p.auto_refresh = 1 AND a.access_expires_at IS NOT NULL`,
      )
      .all() as AuthorizationRow[];
  }
  s2sFor(profileId: number): AuthorizationRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM authorizations WHERE profile_id = ? AND kind = 's2s' ORDER BY id DESC LIMIT 1")
        .get(profileId) as AuthorizationRow | undefined) ?? null
    );
  }
  /**
   * Live authorizations for this Zoom user on the same Zoom app — across every profile that
   * uses this client ID (e.g. duplicated profiles), since Zoom invalidates all of them on re-consent.
   */
  activeForZoomUser(profileId: number, zoomUserId: string): AuthorizationRow[] {
    return this.db
      .prepare(
        `SELECT a.* FROM authorizations a JOIN profiles p ON p.id = a.profile_id
         WHERE p.client_id = (SELECT client_id FROM profiles WHERE id = ?) AND a.kind = 'user'
           AND a.zoom_user_id = ? AND a.status IN ('active', 'failed')`,
      )
      .all(profileId, zoomUserId) as AuthorizationRow[];
  }

  accessToken(r: AuthorizationRow): string | null {
    return this.cipher.decNullable(r.access_token_enc, A_ACCESS);
  }
  refreshToken(r: AuthorizationRow): string | null {
    return this.cipher.decNullable(r.refresh_token_enc, A_REFRESH);
  }

  view(r: AuthorizationRow): AuthorizationView {
    const at = this.accessToken(r);
    const rt = this.refreshToken(r);
    return {
      id: r.id,
      profileId: r.profile_id,
      kind: r.kind,
      zoomUserId: r.zoom_user_id,
      zoomEmail: r.zoom_email,
      zoomName: r.zoom_name,
      zoomAccountId: r.zoom_account_id,
      scopes: (r.scopes ?? '').split(/[\s,]+/).filter(Boolean),
      apiUrl: r.api_url,
      accessTokenHint: at ? mask(at) : null,
      refreshTokenHint: rt ? mask(rt) : null,
      accessExpiresAt: r.access_expires_at,
      issuedAt: r.issued_at,
      lastRefreshedAt: r.last_refreshed_at,
      status: r.status,
      statusDetail: r.status_detail,
      usedPkce: !!r.used_pkce,
      version: r.version,
    };
  }

  /** Insert a fresh authorization (S2S token or user code exchange). */
  insert(p: {
    profileId: number;
    kind: 's2s' | 'user';
    tokens: TokenSet;
    usedPkce?: boolean;
    zoomUserId?: string | null;
    zoomEmail?: string | null;
    zoomName?: string | null;
    zoomAccountId?: string | null;
  }): AuthorizationRow {
    const now = Date.now();
    secrets.add(p.tokens.accessToken);
    secrets.add(p.tokens.refreshToken);
    const info = this.db
      .prepare(
        `INSERT INTO authorizations (profile_id, kind, zoom_user_id, zoom_email, zoom_name, zoom_account_id, scopes, api_url,
           access_token_enc, refresh_token_enc, access_expires_at, issued_at, status, used_pkce, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?)`,
      )
      .run(
        p.profileId,
        p.kind,
        p.zoomUserId ?? null,
        p.zoomEmail ?? null,
        p.zoomName ?? null,
        p.zoomAccountId ?? null,
        p.tokens.scope ?? null,
        p.tokens.apiUrl ?? null,
        this.cipher.encrypt(p.tokens.accessToken, A_ACCESS),
        this.cipher.encNullable(p.tokens.refreshToken, A_REFRESH),
        now + p.tokens.expiresIn * 1000,
        now,
        p.usedPkce ? 1 : 0,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  /**
   * Store a new token pair atomically, but only if nobody else has written since `expectedVersion`.
   * Returns false when the version moved (the caller lost a race and must re-read).
   */
  storeTokens(id: number, expectedVersion: number, t: TokenSet, kind: 'refresh' | 'reissue'): boolean {
    const now = Date.now();
    secrets.add(t.accessToken);
    secrets.add(t.refreshToken);
    const res = this.db
      .prepare(
        `UPDATE authorizations SET
           access_token_enc = @at,
           refresh_token_enc = COALESCE(@rt, refresh_token_enc),
           access_expires_at = @exp,
           scopes = COALESCE(@scope, scopes),
           api_url = COALESCE(@api, api_url),
           ${kind === 'refresh' ? 'last_refreshed_at = @now,' : 'issued_at = @now,'}
           status = 'active', status_detail = NULL,
           version = version + 1,
           refresh_lease_until = NULL, refresh_lease_owner = NULL,
           updated_at = @now
         WHERE id = @id AND version = @v`,
      )
      .run({
        id,
        v: expectedVersion,
        at: this.cipher.encrypt(t.accessToken, A_ACCESS),
        rt: this.cipher.encNullable(t.refreshToken, A_REFRESH),
        exp: now + t.expiresIn * 1000,
        scope: t.scope ?? null,
        api: t.apiUrl ?? null,
        now,
      });
    return res.changes === 1;
  }

  updateIdentity(id: number, u: { zoomUserId?: string | null; zoomEmail?: string | null; zoomName?: string | null; zoomAccountId?: string | null }) {
    this.db
      .prepare(
        'UPDATE authorizations SET zoom_user_id = COALESCE(?, zoom_user_id), zoom_email = COALESCE(?, zoom_email), zoom_name = COALESCE(?, zoom_name), zoom_account_id = COALESCE(?, zoom_account_id), updated_at = ? WHERE id = ?',
      )
      .run(u.zoomUserId ?? null, u.zoomEmail ?? null, u.zoomName ?? null, u.zoomAccountId ?? null, Date.now(), id);
  }

  setStatus(id: number, status: AuthStatus, detail: string | null, clearTokens = false) {
    this.db
      .prepare(
        `UPDATE authorizations SET status = ?, status_detail = ?, ${clearTokens ? 'access_token_enc = NULL, refresh_token_enc = NULL, access_expires_at = NULL,' : ''}
         version = version + 1, refresh_lease_until = NULL, refresh_lease_owner = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(status, detail, Date.now(), id);
  }

  /** Cross-process refresh lease. Returns true if we now hold it. */
  acquireLease(id: number, owner: string, ttlMs: number): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          'UPDATE authorizations SET refresh_lease_until = ?, refresh_lease_owner = ? WHERE id = ? AND (refresh_lease_until IS NULL OR refresh_lease_until < ? OR refresh_lease_owner = ?)',
        )
        .run(now + ttlMs, owner, id, now, owner).changes === 1
    );
  }
  releaseLease(id: number, owner: string) {
    this.db.prepare('UPDATE authorizations SET refresh_lease_until = NULL, refresh_lease_owner = NULL WHERE id = ? AND refresh_lease_owner = ?').run(id, owner);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM authorizations WHERE id = ?').run(id).changes > 0;
  }

  // ---- token events -------------------------------------------------------------
  addEvent(e: Omit<TokenEventRow, 'id' | 'at'> & { at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO token_events (profile_id, authorization_id, at, kind, grant_type, http_status, error_code, error_message, detail, api_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.profile_id,
        e.authorization_id,
        e.at ?? Date.now(),
        e.kind,
        e.grant_type,
        e.http_status,
        e.error_code,
        e.error_message,
        e.detail,
        e.api_call_id,
      );
    // Keep the history short per profile.
    this.db
      .prepare(
        'DELETE FROM token_events WHERE profile_id = ? AND id NOT IN (SELECT id FROM token_events WHERE profile_id = ? ORDER BY id DESC LIMIT 200)',
      )
      .run(e.profile_id, e.profile_id);
  }
  events(profileId: number, limit = 50): TokenEventRow[] {
    return this.db.prepare('SELECT * FROM token_events WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(profileId, limit) as TokenEventRow[];
  }
}
