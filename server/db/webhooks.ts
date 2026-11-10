import type { DB } from './index.js';

export interface WebhookRow {
  id: number;
  received_at: number;
  profile_id: number | null;
  slug: string | null;
  method: string;
  path: string;
  remote_ip: string | null;
  event: string | null;
  event_ts: number | null;
  account_id: string | null;
  signature: string;
  request_ts: string | null;
  is_validation: number;
  duplicate_of: number | null;
  duplicate_kind: string | null;
  body_hash: string | null;
  tracking_id: string | null;
  req_headers: string | null;
  raw_body: Buffer | null;
  raw_redacted: number;
  payload: string | null;
  response_status: number;
  response_body: string | null;
  error: string | null;
  handle_ms: number | null;
}
export type NewWebhook = Omit<WebhookRow, 'id'>;

const FTS_LIMIT = 64 * 1024;
const cap = (s: string | null) => (s == null ? '' : s.length > FTS_LIMIT ? s.slice(0, FTS_LIMIT) : s);

export class WebhooksRepo {
  private ins;
  private fts;
  constructor(private db: DB) {
    const cols = [
      'received_at', 'profile_id', 'slug', 'method', 'path', 'remote_ip', 'event', 'event_ts', 'account_id', 'signature', 'request_ts',
      'is_validation', 'duplicate_of', 'duplicate_kind', 'body_hash', 'tracking_id', 'req_headers', 'raw_body', 'raw_redacted', 'payload',
      'response_status', 'response_body', 'error', 'handle_ms',
    ];
    this.ins = db.prepare(`INSERT INTO webhooks (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
    this.fts = db.prepare('INSERT INTO webhooks_fts (rowid, event, path, headers, body) VALUES (?, ?, ?, ?, ?)');
  }

  /** Earliest earlier delivery with byte-identical body for this profile. */
  findExactDuplicate(profileId: number | null, bodyHash: string): number | null {
    const r = this.db
      .prepare('SELECT id FROM webhooks WHERE profile_id IS ? AND body_hash = ? ORDER BY id LIMIT 1')
      .get(profileId, bodyHash) as { id: number } | undefined;
    return r?.id ?? null;
  }
  /** Earliest earlier delivery of the same event (name + event_ts) with a different body. */
  findSameEvent(profileId: number | null, event: string, eventTs: number): number | null {
    const r = this.db
      .prepare('SELECT id FROM webhooks WHERE profile_id IS ? AND event = ? AND event_ts = ? ORDER BY id LIMIT 1')
      .get(profileId, event, eventTs) as { id: number } | undefined;
    return r?.id ?? null;
  }

  insert(row: NewWebhook): number {
    return this.db.transaction(() => {
      const id = Number(this.ins.run(row).lastInsertRowid);
      this.fts.run(id, row.event ?? '', row.path, cap(row.req_headers), cap(row.raw_body ? row.raw_body.toString('utf8') : ''));
      return id;
    })();
  }

  get(id: number): WebhookRow | null {
    return (this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined) ?? null;
  }
}
