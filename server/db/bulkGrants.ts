import type { DB } from './index.js';
import { aad } from './index.js';
import type { Cipher } from '../lib/crypto.js';
import { mask, secrets } from '../lib/redact.js';

export type BulkStatus = 'waiting' | 'fetching' | 'complete' | 'failed' | 'expired';

/**
 * One admin "authorize for users and groups" event: the bulk access token Zoom issued for a
 * `code_type=bulk` code, and the progress of exchanging it for per-user tokens.
 */
export interface BulkGrantRow {
  id: number;
  profile_id: number;
  bulk_token_enc: string | null;
  token_type: string | null;
  expires_at: number | null;
  batch_size: number;
  status: BulkStatus;
  status_detail: string | null;
  pages: number;
  users_received: number;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  api_url: string | null;
  origin: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface BulkGrantView {
  id: number;
  profileId: number;
  bulkTokenHint: string | null;
  tokenType: string | null;
  expiresAt: number | null;
  batchSize: number;
  status: BulkStatus;
  statusDetail: string | null;
  pages: number;
  usersReceived: number;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  apiUrl: string | null;
  origin: string;
  createdAt: number;
  completedAt: number | null;
  /** Authorizations currently linked to this grant, by status. */
  authorizations: { active: number; other: number };
}

const A_BULK = aad('bulk_grants', 'bulk_token_enc');

export class BulkGrantsRepo {
  constructor(
    private db: DB,
    private cipher: Cipher,
  ) {}

  registerSecrets(): void {
    for (const r of this.db.prepare('SELECT bulk_token_enc FROM bulk_grants WHERE bulk_token_enc IS NOT NULL').all() as BulkGrantRow[]) {
      secrets.add(this.cipher.decNullable(r.bulk_token_enc, A_BULK));
    }
  }

  get(id: number): BulkGrantRow | null {
    return (this.db.prepare('SELECT * FROM bulk_grants WHERE id = ?').get(id) as BulkGrantRow | undefined) ?? null;
  }
  listForProfile(profileId: number, limit = 50): BulkGrantRow[] {
    return this.db.prepare('SELECT * FROM bulk_grants WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(profileId, limit) as BulkGrantRow[];
  }
  /** Grants whose next retrieval attempt is due (also picks up work interrupted by a restart). */
  due(now: number): BulkGrantRow[] {
    return this.db
      .prepare("SELECT * FROM bulk_grants WHERE status IN ('waiting', 'fetching') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id")
      .all(now) as BulkGrantRow[];
  }

  bulkToken(r: BulkGrantRow): string | null {
    return this.cipher.decNullable(r.bulk_token_enc, A_BULK);
  }

  view(r: BulkGrantRow): BulkGrantView {
    const t = this.bulkToken(r);
    const counts = this.db
      .prepare("SELECT SUM(status = 'active') AS active, SUM(status != 'active') AS other FROM authorizations WHERE bulk_grant_id = ?")
      .get(r.id) as { active: number | null; other: number | null };
    return {
      id: r.id,
      profileId: r.profile_id,
      bulkTokenHint: t ? mask(t) : null,
      tokenType: r.token_type,
      expiresAt: r.expires_at,
      batchSize: r.batch_size,
      status: r.status,
      statusDetail: r.status_detail,
      pages: r.pages,
      usersReceived: r.users_received,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
      apiUrl: r.api_url,
      origin: r.origin,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      authorizations: { active: counts.active ?? 0, other: counts.other ?? 0 },
    };
  }

  insert(g: { profileId: number; token: string; tokenType: string | null; expiresIn: number; batchSize: number; firstAttemptAt: number; origin: string }): BulkGrantRow {
    const now = Date.now();
    secrets.add(g.token);
    const info = this.db
      .prepare(
        `INSERT INTO bulk_grants (profile_id, bulk_token_enc, token_type, expires_at, batch_size, status, next_attempt_at, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      )
      .run(g.profileId, this.cipher.encrypt(g.token, A_BULK), g.tokenType, now + g.expiresIn * 1000, g.batchSize, g.firstAttemptAt, g.origin, now, now);
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, f: Partial<Pick<BulkGrantRow, 'status' | 'status_detail' | 'pages' | 'users_received' | 'attempts' | 'next_attempt_at' | 'last_error' | 'api_url' | 'completed_at'>>) {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE bulk_grants SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...f, id, now: Date.now() });
  }

  /** Forget the bulk token itself (it is useless once expired, and only ever grants retrieval). */
  clearToken(id: number) {
    this.db.prepare('UPDATE bulk_grants SET bulk_token_enc = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM bulk_grants WHERE id = ?').run(id).changes > 0;
  }
}
