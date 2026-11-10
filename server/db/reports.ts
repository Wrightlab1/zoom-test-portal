import { z } from 'zod';
import type { DB } from './index.js';

/** Turn free text into a safe FTS5 query: every term quoted, last one a prefix. */
export function ftsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!terms.length) return null;
  // Tokens made only of separators would make FTS5 throw; keep ones with at least one word char.
  const usable = terms.filter((t) => /[\p{L}\p{N}_]/u.test(t));
  if (!usable.length) return null;
  return usable.map((t) => `"${t}"*`).join(' ');
}

const csvList = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []));
const numList = csvList.transform((a) => a.map(Number).filter((n) => Number.isFinite(n)));
const optNum = z.coerce.number().optional();

const common = {
  from: optNum,
  to: optNum,
  profileId: numList,
  q: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  dir: z.enum(['asc', 'desc']).default('desc'),
};

export const callFilters = z.object({
  ...common,
  sort: z.enum(['ts', 'method', 'url', 'endpoint', 'status', 'duration_ms', 'profile_id', 'tracking_id', 'category', 'rl_remaining', 'resp_size', 'id']).default('ts'),
  category: z.enum(['api', 'token', 'all']).default('api'),
  method: csvList,
  status: numList,
  statusClass: csvList,
  endpoint: z.string().max(500).optional(),
  authorizationId: optNum,
  trackingId: z.string().max(300).optional(),
  retried: z.enum(['0', '1']).optional(),
});
export type CallFilters = z.infer<typeof callFilters>;

export const webhookFilters = z.object({
  ...common,
  sort: z.enum(['received_at', 'event', 'signature', 'response_status', 'profile_id', 'event_ts', 'handle_ms', 'account_id', 'id']).default('received_at'),
  event: csvList,
  eventResource: csvList,
  signature: csvList,
  responseStatus: numList,
  validation: z.enum(['only', 'exclude', 'all']).default('all'),
  duplicates: z.enum(['only', 'exclude', 'all']).default('all'),
  accountId: z.string().max(200).optional(),
  trackingId: z.string().max(300).optional(),
});
export type WebhookFilters = z.infer<typeof webhookFilters>;

interface Where {
  sql: string;
  params: unknown[];
}

function inList(col: string, vals: unknown[], params: unknown[]): string {
  params.push(...vals);
  return `${col} IN (${vals.map(() => '?').join(', ')})`;
}

export function callWhere(f: CallFilters): Where {
  const c: string[] = [];
  const p: unknown[] = [];
  if (f.category !== 'all') {
    c.push('category = ?');
    p.push(f.category);
  }
  if (f.from != null) {
    c.push('ts >= ?');
    p.push(f.from);
  }
  if (f.to != null) {
    c.push('ts <= ?');
    p.push(f.to);
  }
  if (f.profileId.length) c.push(inList('profile_id', f.profileId, p));
  if (f.method.length) c.push(inList('method', f.method.map((m) => m.toUpperCase()), p));
  if (f.status.length) c.push(inList('status', f.status, p));
  if (f.statusClass.length) c.push(inList('status_class', f.statusClass, p));
  if (f.endpoint) {
    c.push('(endpoint LIKE ? ESCAPE \'\\\' OR path LIKE ? ESCAPE \'\\\')');
    const like = `%${f.endpoint.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    p.push(like, like);
  }
  if (f.authorizationId != null) {
    c.push('authorization_id = ?');
    p.push(f.authorizationId);
  }
  if (f.trackingId) {
    c.push('tracking_id = ?');
    p.push(f.trackingId);
  }
  if (f.retried === '1') c.push('(retry_of IS NOT NULL OR id IN (SELECT retry_of FROM api_calls WHERE retry_of IS NOT NULL))');
  const fq = f.q ? ftsQuery(f.q) : null;
  if (fq) {
    c.push('id IN (SELECT rowid FROM api_calls_fts WHERE api_calls_fts MATCH ?)');
    p.push(fq);
  }
  return { sql: c.length ? 'WHERE ' + c.join(' AND ') : '', params: p };
}

export function webhookWhere(f: WebhookFilters): Where {
  const c: string[] = [];
  const p: unknown[] = [];
  if (f.from != null) {
    c.push('received_at >= ?');
    p.push(f.from);
  }
  if (f.to != null) {
    c.push('received_at <= ?');
    p.push(f.to);
  }
  if (f.profileId.length) c.push(inList('profile_id', f.profileId, p));
  if (f.event.length) c.push(inList('event', f.event, p));
  if (f.eventResource.length) {
    c.push('(' + f.eventResource.map(() => "event LIKE ? || '.%'").join(' OR ') + ')');
    p.push(...f.eventResource);
  }
  if (f.signature.length) c.push(inList('signature', f.signature, p));
  if (f.responseStatus.length) c.push(inList('response_status', f.responseStatus, p));
  if (f.validation === 'only') c.push('is_validation = 1');
  if (f.validation === 'exclude') c.push('is_validation = 0');
  if (f.duplicates === 'only') c.push('duplicate_of IS NOT NULL');
  if (f.duplicates === 'exclude') c.push('duplicate_of IS NULL');
  if (f.accountId) {
    c.push('account_id = ?');
    p.push(f.accountId);
  }
  if (f.trackingId) {
    c.push('tracking_id = ?');
    p.push(f.trackingId);
  }
  const fq = f.q ? ftsQuery(f.q) : null;
  if (fq) {
    c.push('id IN (SELECT rowid FROM webhooks_fts WHERE webhooks_fts MATCH ?)');
    p.push(fq);
  }
  return { sql: c.length ? 'WHERE ' + c.join(' AND ') : '', params: p };
}

const CALL_LIST_COLS = `id, ts, category, profile_id, authorization_id, auth_type, grant_type, method, url, endpoint, status, status_class,
  duration_ms, error, tracking_id, zoom_error_code, zoom_error_message, rl_category, rl_type, rl_limit, rl_remaining, resp_size,
  attempt, retry_of, replay_of, collection_request_id`;
const WEBHOOK_LIST_COLS = `id, received_at, profile_id, slug, method, path, event, event_ts, account_id, signature, is_validation,
  duplicate_of, duplicate_kind, tracking_id, response_status, error, handle_ms, length(raw_body) AS body_size`;

function bucketFor(from: number | undefined, to: number | undefined): { ms: number; label: 'minute' | 'hour' | 'day' | 'week' } {
  const span = (to ?? Date.now()) - (from ?? Date.now() - 7 * 86400_000);
  if (span <= 3 * 3600_000) return { ms: 60_000, label: 'minute' };
  if (span <= 3 * 86400_000) return { ms: 3600_000, label: 'hour' };
  if (span <= 90 * 86400_000) return { ms: 86400_000, label: 'day' };
  return { ms: 7 * 86400_000, label: 'week' };
}

export class ReportsRepo {
  constructor(private db: DB) {}

  // ------------------------------------------------------------------ API calls
  listCalls(f: CallFilters) {
    const w = callWhere(f);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM api_calls ${w.sql}`).get(...w.params) as { n: number }).n;
    const nulls = f.dir === 'asc' ? 'NULLS FIRST' : 'NULLS LAST';
    const rows = this.db
      .prepare(`SELECT ${CALL_LIST_COLS} FROM api_calls ${w.sql} ORDER BY ${f.sort} ${f.dir} ${nulls}, id ${f.dir} LIMIT ? OFFSET ?`)
      .all(...w.params, f.pageSize, (f.page - 1) * f.pageSize);
    return { total, page: f.page, pageSize: f.pageSize, rows };
  }

  private percentiles(table: string, col: string, where: Where) {
    const out: Record<string, number | null> = {};
    const nonNull = `${where.sql ? where.sql + ' AND' : 'WHERE'} ${col} IS NOT NULL`;
    const count = (this.db.prepare(`SELECT COUNT(*) n FROM ${table} ${nonNull}`).get(...where.params) as { n: number }).n;
    for (const [k, q] of [['p50', 0.5], ['p90', 0.9], ['p95', 0.95], ['p99', 0.99]] as const) {
      if (!count) {
        out[k] = null;
        continue;
      }
      const off = Math.min(count - 1, Math.floor(q * count));
      const r = this.db.prepare(`SELECT ${col} v FROM ${table} ${nonNull} ORDER BY ${col} LIMIT 1 OFFSET ?`).get(...where.params, off) as { v: number } | undefined;
      out[k] = r?.v ?? null;
    }
    const agg = this.db.prepare(`SELECT AVG(${col}) avg, MAX(${col}) max, MIN(${col}) min FROM ${table} ${nonNull}`).get(...where.params) as Record<string, number | null>;
    return { ...out, avg: agg.avg == null ? null : Math.round(agg.avg * 10) / 10, max: agg.max, min: agg.min, count };
  }

  callSummary(f: CallFilters) {
    const w = callWhere(f);
    const q = <T>(sql: string, ...extra: unknown[]) => this.db.prepare(sql).all(...w.params, ...extra) as T[];
    const and = w.sql ? `${w.sql} AND` : 'WHERE';
    const totals = this.db
      .prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) failures, SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) retries FROM api_calls ${w.sql}`)
      .get(...w.params) as { total: number; failures: number | null; retries: number | null };
    const bucket = bucketFor(f.from, f.to);
    return {
      total: totals.total,
      failures: totals.failures ?? 0,
      retries: totals.retries ?? 0,
      errorRate: totals.total ? (totals.failures ?? 0) / totals.total : 0,
      byStatusClass: q<{ key: string; count: number }>(`SELECT status_class key, COUNT(*) count FROM api_calls ${w.sql} GROUP BY status_class ORDER BY count DESC`),
      byStatus: q<{ status: number | null; count: number; zoomErrorCode: string | null }>(
        `SELECT status, COUNT(*) count, MAX(zoom_error_code) zoomErrorCode FROM api_calls ${w.sql} GROUP BY status ORDER BY count DESC LIMIT 20`,
      ),
      failuresByStatus: q<{ status: number | null; count: number; message: string | null }>(
        `SELECT status, COUNT(*) count, MAX(COALESCE(zoom_error_message, error)) message FROM api_calls ${and} (status >= 400 OR status IS NULL) GROUP BY status ORDER BY count DESC LIMIT 10`,
      ),
      byEndpoint: q<{ method: string; endpoint: string; count: number; failures: number; avgMs: number }>(
        `SELECT method, endpoint, COUNT(*) count, SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) failures, ROUND(AVG(duration_ms), 1) avgMs
         FROM api_calls ${w.sql} GROUP BY method, endpoint ORDER BY count DESC LIMIT 15`,
      ),
      byMethod: q<{ key: string; count: number }>(`SELECT method key, COUNT(*) count FROM api_calls ${w.sql} GROUP BY method ORDER BY count DESC`),
      byProfile: q<{ profileId: number | null; count: number }>(`SELECT profile_id profileId, COUNT(*) count FROM api_calls ${w.sql} GROUP BY profile_id ORDER BY count DESC`),
      latency: this.percentiles('api_calls', 'duration_ms', w),
      series: {
        bucket: bucket.label,
        bucketMs: bucket.ms,
        points: q<{ t: number; ok: number; failed: number }>(
          `SELECT (ts / ${bucket.ms}) * ${bucket.ms} t, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) failed
           FROM api_calls ${w.sql} GROUP BY t ORDER BY t`,
        ),
      },
      // Latest rate-limit headers seen per category (limits are shared by all apps on the account).
      rateLimits: this.db
        .prepare(
          `SELECT rl_category category, rl_type type, rl_limit "limit", rl_remaining remaining, ts, profile_id profileId FROM api_calls
           WHERE id IN (SELECT MAX(id) FROM api_calls ${and} rl_category IS NOT NULL GROUP BY rl_category, rl_type, profile_id)
           ORDER BY ts DESC`,
        )
        .all(...w.params),
    };
  }

  // ------------------------------------------------------------------ webhooks
  listWebhooks(f: WebhookFilters) {
    const w = webhookWhere(f);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM webhooks ${w.sql}`).get(...w.params) as { n: number }).n;
    const nulls = f.dir === 'asc' ? 'NULLS FIRST' : 'NULLS LAST';
    const rows = this.db
      .prepare(`SELECT ${WEBHOOK_LIST_COLS} FROM webhooks ${w.sql} ORDER BY ${f.sort} ${f.dir} ${nulls}, id ${f.dir} LIMIT ? OFFSET ?`)
      .all(...w.params, f.pageSize, (f.page - 1) * f.pageSize);
    return { total, page: f.page, pageSize: f.pageSize, rows };
  }

  webhookSummary(f: WebhookFilters) {
    const w = webhookWhere(f);
    const q = <T>(sql: string) => this.db.prepare(sql).all(...w.params) as T[];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) total, SUM(CASE WHEN signature != 'valid' THEN 1 ELSE 0 END) rejected, SUM(CASE WHEN duplicate_of IS NOT NULL THEN 1 ELSE 0 END) duplicates,
                SUM(is_validation) validations, SUM(CASE WHEN response_status >= 400 THEN 1 ELSE 0 END) non2xx FROM webhooks ${w.sql}`,
      )
      .get(...w.params) as Record<string, number | null>;
    const bucket = bucketFor(f.from, f.to);
    return {
      total: totals.total ?? 0,
      rejected: totals.rejected ?? 0,
      duplicates: totals.duplicates ?? 0,
      validations: totals.validations ?? 0,
      non2xx: totals.non2xx ?? 0,
      errorRate: totals.total ? (totals.non2xx ?? 0) / (totals.total ?? 1) : 0,
      bySignature: q<{ key: string; count: number }>(`SELECT signature key, COUNT(*) count FROM webhooks ${w.sql} GROUP BY signature ORDER BY count DESC`),
      byEvent: q<{ key: string | null; count: number; rejected: number }>(
        `SELECT event key, COUNT(*) count, SUM(CASE WHEN signature != 'valid' THEN 1 ELSE 0 END) rejected FROM webhooks ${w.sql} GROUP BY event ORDER BY count DESC LIMIT 15`,
      ),
      byResponseStatus: q<{ key: number; count: number }>(`SELECT response_status key, COUNT(*) count FROM webhooks ${w.sql} GROUP BY response_status ORDER BY count DESC`),
      byProfile: q<{ profileId: number | null; count: number }>(`SELECT profile_id profileId, COUNT(*) count FROM webhooks ${w.sql} GROUP BY profile_id ORDER BY count DESC`),
      handleMs: this.percentiles('webhooks', 'handle_ms', w),
      series: {
        bucket: bucket.label,
        bucketMs: bucket.ms,
        points: q<{ t: number; ok: number; failed: number }>(
          `SELECT (received_at / ${bucket.ms}) * ${bucket.ms} t, SUM(CASE WHEN response_status < 400 THEN 1 ELSE 0 END) ok, SUM(CASE WHEN response_status >= 400 THEN 1 ELSE 0 END) failed
           FROM webhooks ${w.sql} GROUP BY t ORDER BY t`,
        ),
      },
      eventNames: this.db.prepare('SELECT DISTINCT event FROM webhooks WHERE event IS NOT NULL ORDER BY event LIMIT 500').pluck().all(),
    };
  }

  // ------------------------------------------------------------------ export
  *iterateCalls(f: CallFilters): Generator<Record<string, unknown>> {
    const w = callWhere(f);
    yield* this.db.prepare(`SELECT * FROM api_calls ${w.sql} ORDER BY ${f.sort} ${f.dir}, id ${f.dir}`).iterate(...w.params) as Iterable<Record<string, unknown>>;
  }
  *iterateWebhooks(f: WebhookFilters): Generator<Record<string, unknown>> {
    const w = webhookWhere(f);
    yield* this.db.prepare(`SELECT * FROM webhooks ${w.sql} ORDER BY ${f.sort} ${f.dir}, id ${f.dir}`).iterate(...w.params) as Iterable<Record<string, unknown>>;
  }

  // ------------------------------------------------------------------ retention
  purgeOlderThan(cutoff: number): { calls: number; webhooks: number } {
    let calls = 0;
    let webhooks = 0;
    const batch = 5000;
    for (;;) {
      const ids = this.db.prepare('SELECT id FROM api_calls WHERE ts < ? LIMIT ?').pluck().all(cutoff, batch) as number[];
      if (!ids.length) break;
      this.db.transaction(() => {
        const delFts = this.db.prepare('DELETE FROM api_calls_fts WHERE rowid = ?');
        const del = this.db.prepare('DELETE FROM api_calls WHERE id = ?');
        for (const id of ids) {
          delFts.run(id);
          del.run(id);
        }
      })();
      calls += ids.length;
    }
    for (;;) {
      const ids = this.db.prepare('SELECT id FROM webhooks WHERE received_at < ? LIMIT ?').pluck().all(cutoff, batch) as number[];
      if (!ids.length) break;
      this.db.transaction(() => {
        const delFts = this.db.prepare('DELETE FROM webhooks_fts WHERE rowid = ?');
        const del = this.db.prepare('DELETE FROM webhooks WHERE id = ?');
        for (const id of ids) {
          delFts.run(id);
          del.run(id);
        }
      })();
      webhooks += ids.length;
    }
    this.db.prepare('DELETE FROM tunnel_history WHERE started_at < ?').run(cutoff);
    return { calls, webhooks };
  }

  // ------------------------------------------------------------------ saved filters
  listSavedFilters(view: 'calls' | 'webhooks') {
    return (this.db.prepare('SELECT id, name, filter, created_at createdAt FROM saved_filters WHERE view = ? ORDER BY name COLLATE NOCASE').all(view) as { filter: string }[]).map((r) => ({
      ...r,
      filter: JSON.parse(r.filter),
    }));
  }
  saveFilter(view: 'calls' | 'webhooks', name: string, filter: Record<string, unknown>): number {
    return Number(
      this.db
        .prepare('INSERT INTO saved_filters (view, name, filter, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(view, name) DO UPDATE SET filter = excluded.filter RETURNING id')
        .pluck()
        .get(view, name, JSON.stringify(filter), Date.now()),
    );
  }
  deleteFilter(id: number): boolean {
    return this.db.prepare('DELETE FROM saved_filters WHERE id = ?').run(id).changes > 0;
  }
}
