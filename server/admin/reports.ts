import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { callFilters, webhookFilters } from '../db/reports.js';
import { HttpError, idParam } from './util.js';
import { callView, webhookView } from './views.js';
import type { ApiCallRow } from '../db/calls.js';
import type { WebhookRow } from '../db/webhooks.js';

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formula injection and quote everything that needs it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const CALL_CSV = ['id', 'ts', 'category', 'profile_id', 'authorization_id', 'auth_type', 'grant_type', 'method', 'url', 'endpoint', 'status', 'duration_ms', 'error', 'tracking_id', 'zoom_error_code', 'zoom_error_message', 'rl_category', 'rl_type', 'rl_limit', 'rl_remaining', 'rl_reset', 'retry_after', 'attempt', 'retry_of', 'replay_of', 'query', 'req_headers', 'req_body', 'resp_headers', 'resp_body', 'resp_body_truncated', 'resp_size', 'resp_content_type', 'redirects'];
const WEBHOOK_CSV = ['id', 'received_at', 'profile_id', 'slug', 'method', 'path', 'remote_ip', 'event', 'event_ts', 'account_id', 'signature', 'request_ts', 'is_validation', 'duplicate_of', 'duplicate_kind', 'body_hash', 'tracking_id', 'response_status', 'error', 'handle_ms', 'req_headers', 'raw_body', 'raw_redacted', 'response_body'];

/** Stream an export. Everything comes from the log tables, which only ever hold redacted values. */
function streamExport(reply: FastifyReply, name: string, format: 'csv' | 'json', cols: string[], rows: Iterable<Record<string, unknown>>, map: (r: Record<string, unknown>) => unknown) {
  reply.hijack();
  const res = reply.raw;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.writeHead(200, {
    'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${name}-${stamp}.${format}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (format === 'csv') {
    res.write('﻿' + cols.join(',') + '\n');
    for (const r of rows) res.write(cols.map((c) => csvCell(r[c] ?? null)).join(',') + '\n');
  } else {
    res.write('[');
    let first = true;
    for (const r of rows) {
      res.write((first ? '\n' : ',\n') + JSON.stringify(map(r)));
      first = false;
    }
    res.write('\n]\n');
  }
  res.end();
}

export function registerReportRoutes(app: FastifyInstance, ctx: Ctx) {
  const s = ctx.services;

  app.get('/api/reports/calls', async (req) => s.reports.listCalls(callFilters.parse(req.query)));
  app.get('/api/reports/calls/summary', async (req) => s.reports.callSummary(callFilters.parse(req.query)));
  app.get('/api/reports/calls/export', async (req, reply) => {
    const { format } = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    streamExport(reply, 'api-calls', format, CALL_CSV, s.reports.iterateCalls(callFilters.parse(req.query)), (r) => callView(r as unknown as ApiCallRow));
  });
  app.get('/api/calls/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = s.calls.get(id);
    if (!row) throw new HttpError(404, 'not_found');
    const related = ctx.db
      .prepare('SELECT id, attempt, status, retry_of retryOf, replay_of replayOf FROM api_calls WHERE id = ? OR retry_of = ? OR id = ? OR replay_of = ? ORDER BY id')
      .all(id, id, row.retry_of ?? -1, id);
    return { ...callView(row), related };
  });

  app.get('/api/reports/webhooks', async (req) => s.reports.listWebhooks(webhookFilters.parse(req.query)));
  app.get('/api/reports/webhooks/summary', async (req) => s.reports.webhookSummary(webhookFilters.parse(req.query)));
  app.get('/api/reports/webhooks/export', async (req, reply) => {
    const { format } = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    streamExport(reply, 'webhooks', format, WEBHOOK_CSV, s.reports.iterateWebhooks(webhookFilters.parse(req.query)), (r) => webhookView(r as unknown as WebhookRow, { full: true }));
  });
  app.get('/api/webhooks/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = s.webhooksRepo.get(id);
    if (!row) throw new HttpError(404, 'not_found');
    const root = row.duplicate_of ?? row.id;
    const deliveries = ctx.db
      .prepare('SELECT id, received_at receivedAt, signature, response_status responseStatus, duplicate_kind duplicateKind FROM webhooks WHERE id = ? OR duplicate_of = ? ORDER BY id')
      .all(root, root);
    return { ...webhookView(row, { full: true }), deliveries };
  });

  // ---- saved filters ----
  const view = z.object({ view: z.enum(['calls', 'webhooks']) });
  app.get('/api/saved-filters', async (req) => s.reports.listSavedFilters(view.parse(req.query).view));
  app.post('/api/saved-filters', async (req) => {
    const b = view.extend({ name: z.string().trim().min(1).max(100), filter: z.record(z.string(), z.unknown()) }).parse(req.body);
    return { id: s.reports.saveFilter(b.view, b.name, b.filter) };
  });
  app.delete('/api/saved-filters/:id', async (req) => {
    if (!s.reports.deleteFilter(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  // ---- retention ----
  app.post('/api/logs/purge', async (req) => {
    const { olderThanDays } = z.object({ olderThanDays: z.number().min(0).max(3650) }).parse(req.body);
    return s.reports.purgeOlderThan(Date.now() - olderThanDays * 86400_000);
  });
}
