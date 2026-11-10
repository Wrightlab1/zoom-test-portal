import type { DB } from './index.js';

export interface ApiCallRow {
  id: number;
  ts: number;
  category: 'api' | 'token';
  profile_id: number | null;
  authorization_id: number | null;
  auth_type: string | null;
  grant_type: string | null;
  method: string;
  url: string;
  host: string | null;
  path: string | null;
  endpoint: string | null;
  collection_request_id: number | null;
  saved_request_id: number | null;
  query: string | null;
  req_headers: string | null;
  req_body: string | null;
  status: number | null;
  status_class: string | null;
  resp_headers: string | null;
  resp_body: string | null;
  resp_body_truncated: number;
  resp_size: number | null;
  resp_content_type: string | null;
  duration_ms: number | null;
  error: string | null;
  tracking_id: string | null;
  zoom_error_code: string | null;
  zoom_error_message: string | null;
  rl_category: string | null;
  rl_type: string | null;
  rl_limit: number | null;
  rl_remaining: number | null;
  rl_reset: string | null;
  retry_after: string | null;
  attempt: number;
  retry_of: number | null;
  replay_of: number | null;
  redirects: string | null;
}

export type NewApiCall = Omit<ApiCallRow, 'id'>;

/** FTS gets at most this much of each field, to keep the index bounded. */
const FTS_FIELD_LIMIT = 64 * 1024;
const cap = (s: string | null) => (s == null ? '' : s.length > FTS_FIELD_LIMIT ? s.slice(0, FTS_FIELD_LIMIT) : s);

export class CallsRepo {
  private insertStmt;
  private ftsStmt;
  constructor(private db: DB) {
    const cols = [
      'ts', 'category', 'profile_id', 'authorization_id', 'auth_type', 'grant_type', 'method', 'url', 'host', 'path', 'endpoint',
      'collection_request_id', 'saved_request_id', 'query', 'req_headers', 'req_body', 'status', 'status_class', 'resp_headers',
      'resp_body', 'resp_body_truncated', 'resp_size', 'resp_content_type', 'duration_ms', 'error', 'tracking_id', 'zoom_error_code',
      'zoom_error_message', 'rl_category', 'rl_type', 'rl_limit', 'rl_remaining', 'rl_reset', 'retry_after', 'attempt', 'retry_of',
      'replay_of', 'redirects',
    ];
    this.insertStmt = db.prepare(`INSERT INTO api_calls (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
    this.ftsStmt = db.prepare('INSERT INTO api_calls_fts (rowid, url, req_headers, req_body, resp_headers, resp_body) VALUES (?, ?, ?, ?, ?, ?)');
  }

  insert(row: NewApiCall): number {
    return this.db.transaction(() => {
      const id = Number(this.insertStmt.run(row).lastInsertRowid);
      this.ftsStmt.run(id, cap(row.url), cap(row.req_headers), cap(row.req_body), cap(row.resp_headers), cap(row.resp_body));
      return id;
    })();
  }

  get(id: number): ApiCallRow | null {
    return (this.db.prepare('SELECT * FROM api_calls WHERE id = ?').get(id) as ApiCallRow | undefined) ?? null;
  }
}
