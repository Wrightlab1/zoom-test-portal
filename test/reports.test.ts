import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, S2S_CLIENT, WEBHOOK_SECRET, type Harness } from './helpers.js';
import { sendWebhook, sampleEvent } from '../mock-zoom/webhookSender.js';
import { ftsQuery } from '../server/db/reports.js';

let h: Harness;
let pid: number;
beforeAll(async () => {
  h = await startHarness();
  const p = await h.admin.post('/api/profiles', { name: 'Reports', type: 's2s', clientId: S2S_CLIENT.clientId, clientSecret: S2S_CLIENT.clientSecret, accountId: 'mockaccount1', webhookSecret: WEBHOOK_SECRET });
  pid = p.body.id;
  const send = (url: string, method = 'GET', body?: string) => h.admin.post('/api/send', { profileId: pid, method, url, body });
  await send('{{baseUrl}}/users');
  await send('{{baseUrl}}/users');
  await send('{{baseUrl}}/ratelimit-test');
  await send('{{baseUrl}}/nope');
  await send('{{baseUrl}}/users/me/meetings', 'POST', '{"topic":"needle-topic-xyz"}');
  const url = p.body.urls.webhookUrl;
  await sendWebhook({ url, secret: WEBHOOK_SECRET, body: JSON.stringify(sampleEvent('meeting.started')) });
  const dup = JSON.stringify(sampleEvent('meeting.ended'));
  await sendWebhook({ url, secret: WEBHOOK_SECRET, body: dup });
  await sendWebhook({ url, secret: WEBHOOK_SECRET, body: dup });
  await sendWebhook({ url, secret: WEBHOOK_SECRET, badSignature: true, event: 'user.signed_in' });
});
afterAll(async () => h?.close());

describe('API call report', () => {
  it('lists with server-side paging and sorting', async () => {
    const r = await h.admin.get('/api/reports/calls?pageSize=2&sort=status&dir=desc');
    expect(r.body.total).toBe(5);
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.rows[0].status).toBe(429);
    const p3 = await h.admin.get('/api/reports/calls?pageSize=2&page=3&sort=status&dir=desc');
    expect(p3.body.rows).toHaveLength(1);
  });

  it('filters by method, status, status class, endpoint, profile, date and category', async () => {
    expect((await h.admin.get('/api/reports/calls?method=POST')).body.total).toBe(1);
    expect((await h.admin.get('/api/reports/calls?status=200')).body.total).toBe(2);
    expect((await h.admin.get('/api/reports/calls?statusClass=4xx')).body.total).toBe(2);
    expect((await h.admin.get('/api/reports/calls?endpoint=ratelimit')).body.total).toBe(1);
    expect((await h.admin.get(`/api/reports/calls?profileId=${pid}`)).body.total).toBe(5);
    expect((await h.admin.get(`/api/reports/calls?from=${Date.now() + 60_000}`)).body.total).toBe(0);
    expect((await h.admin.get('/api/reports/calls?category=token')).body.total).toBe(1);
    expect((await h.admin.get('/api/reports/calls?category=all')).body.total).toBe(6);
  });

  it('full-text searches URLs, headers and bodies', async () => {
    expect((await h.admin.get('/api/reports/calls?q=needle-topic')).body.total).toBe(1);
    expect((await h.admin.get('/api/reports/calls?q=ratelimit-test')).body.total).toBe(1);
    expect((await h.admin.get('/api/reports/calls?q=x-ratelimit-category')).body.total).toBeGreaterThanOrEqual(4);
    expect((await h.admin.get('/api/reports/calls?q=' + encodeURIComponent('"); DROP TABLE api_calls; --'))).status).toBe(200);
  });

  it('summarizes status, endpoints, latency percentiles and rate limits', async () => {
    const s = (await h.admin.get('/api/reports/calls/summary')).body;
    expect(s.total).toBe(5);
    expect(s.failures).toBe(2);
    expect(s.errorRate).toBeCloseTo(0.4);
    expect(s.byEndpoint[0]).toMatchObject({ method: 'GET', endpoint: '/users', count: 2 });
    expect(s.latency.p50).toBeGreaterThan(0);
    expect(s.latency.p99).toBeGreaterThanOrEqual(s.latency.p50);
    expect(s.rateLimits.map((r: any) => r.category).sort()).toEqual(expect.arrayContaining(['Heavy', 'Medium']));
    expect(s.series.points.reduce((a: number, p: any) => a + p.ok + p.failed, 0)).toBe(5);
    expect(s.failuresByStatus.map((x: any) => x.status).sort()).toEqual([404, 429]);
  });

  it('exports CSV and JSON of the filtered set, redacted', async () => {
    const csv = await fetch(h.adminUrl + '/api/reports/calls/export?format=csv&status=200', { headers: { cookie: h.admin.cookie } });
    const text = await csv.text();
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="api-calls-.*\.csv"/);
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(text).not.toMatch(/mock_at_[A-Za-z0-9_-]{10}/);
    expect(text).toContain('[REDACTED]');
    const json = await (await fetch(h.adminUrl + '/api/reports/calls/export?format=json&category=all', { headers: { cookie: h.admin.cookie } })).json();
    expect(json).toHaveLength(6);
    expect(JSON.stringify(json)).not.toContain(S2S_CLIENT.clientSecret);
  });

  it('guards CSV against formula injection', async () => {
    await h.admin.post('/api/send', { profileId: pid, method: 'POST', url: '{{baseUrl}}/users/me/meetings', body: '=HYPERLINK("http://evil")' });
    const text = await (await fetch(h.adminUrl + '/api/reports/calls/export?format=csv&method=POST', { headers: { cookie: h.admin.cookie } })).text();
    expect(text).toContain(`"'=HYPERLINK`);
  });

  it('opens a call with its retry/replay relations', async () => {
    const id = (await h.admin.get('/api/reports/calls?pageSize=1')).body.rows[0].id;
    const d = (await h.admin.get(`/api/calls/${id}`)).body;
    expect(d.requestHeaders).toBeTypeOf('object');
    expect(d.related.length).toBeGreaterThanOrEqual(1);
  });
});

describe('webhook report', () => {
  it('lists, filters and flags duplicates and signature failures', async () => {
    const all = (await h.admin.get('/api/reports/webhooks')).body;
    expect(all.total).toBe(4);
    expect((await h.admin.get('/api/reports/webhooks?signature=invalid')).body.rows[0]).toMatchObject({ event: 'user.signed_in', response_status: 401 });
    expect((await h.admin.get('/api/reports/webhooks?duplicates=only')).body.total).toBe(1);
    expect((await h.admin.get('/api/reports/webhooks?eventResource=meeting')).body.total).toBe(3);
    expect((await h.admin.get('/api/reports/webhooks?event=meeting.ended')).body.total).toBe(2);
    expect((await h.admin.get('/api/reports/webhooks?q=meeting.ended')).body.total).toBe(2);
  });

  it('summarizes by signature, event and response', async () => {
    const s = (await h.admin.get('/api/reports/webhooks/summary')).body;
    expect(s).toMatchObject({ total: 4, rejected: 1, duplicates: 1, non2xx: 1 });
    expect(s.bySignature.find((x: any) => x.key === 'valid').count).toBe(3);
    expect(s.eventNames).toEqual(['meeting.ended', 'meeting.started', 'user.signed_in']);
  });

  it('opens a webhook with raw body, headers and the delivery chain', async () => {
    const id = (await h.admin.get('/api/reports/webhooks?duplicates=only')).body.rows[0].id;
    const d = (await h.admin.get(`/api/webhooks/${id}`)).body;
    expect(d.rawBody).toContain('"event":"meeting.ended"');
    expect(d.deliveries).toHaveLength(2);
    expect(d.requestHeaders['x-zm-signature']).toMatch(/^v0=/);
  });

  it('exports webhooks', async () => {
    const json = await (await fetch(h.adminUrl + '/api/reports/webhooks/export?format=json', { headers: { cookie: h.admin.cookie } })).json();
    expect(json).toHaveLength(4);
    expect(json[0].rawBody).toBeTruthy();
  });
});

describe('saved filters and retention', () => {
  it('saves, lists and deletes named filters', async () => {
    const r = await h.admin.post('/api/saved-filters', { view: 'calls', name: 'Failures', filter: { statusClass: '4xx,5xx' } });
    const list = (await h.admin.get('/api/saved-filters?view=calls')).body;
    expect(list).toEqual([expect.objectContaining({ id: r.body.id, name: 'Failures', filter: { statusClass: '4xx,5xx' } })]);
    expect((await h.admin.del(`/api/saved-filters/${r.body.id}`)).status).toBe(200);
  });

  it('purges old rows including their search index entries', async () => {
    h.app.ctx.db.prepare('UPDATE api_calls SET ts = ? WHERE method = ?').run(Date.now() - 40 * 86400_000, 'POST');
    h.app.ctx.settings.update({ retentionDays: 30 });
    const r = h.app.ctx.services.applyRetention();
    expect(r!.calls).toBe(3); // two API POSTs + the POST to the token endpoint
    expect((await h.admin.get('/api/reports/calls?q=needle-topic')).body.total).toBe(0);
    h.app.ctx.settings.update({ retentionDays: 0 });
    expect(h.app.ctx.services.applyRetention()).toBeNull();
  });
});

describe('FTS query sanitizing', () => {
  it('quotes terms and drops punctuation-only tokens', () => {
    expect(ftsQuery('foo bar')).toBe('"foo"* "bar"*');
    expect(ftsQuery('"; --')).toBeNull();
    expect(ftsQuery('a"b')).toBe('"ab"*');
  });
});

describe('scale: hundreds of thousands of rows', () => {
  it('stays responsive for paging, sorting, filtering, search and summaries', async () => {
    const db = h.app.ctx.db;
    const calls = h.app.ctx.services.calls;
    const N = 200_000;
    const methods = ['GET', 'POST', 'PATCH', 'DELETE'];
    const statuses = [200, 200, 200, 201, 204, 400, 401, 404, 429, 500];
    const t0 = Date.now() - 30 * 86400_000;
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const status = statuses[i % statuses.length];
        calls.insert({
          ts: t0 + i * 12_000, category: 'api', profile_id: pid, authorization_id: null, auth_type: 's2s', grant_type: null,
          method: methods[i % 4], url: `https://api.zoom.us/v2/users/u${i % 500}/meetings?page_size=30`, host: 'api.zoom.us', path: `/v2/users/u${i % 500}/meetings`,
          endpoint: `/users/:userId/meetings${i % 7}`, collection_request_id: null, saved_request_id: null, query: 'page_size=30',
          req_headers: '{"Authorization":"Bearer [REDACTED]…abcd","Accept":"application/json"}', req_body: null, status, status_class: `${Math.floor(status / 100)}xx`,
          resp_headers: `{"content-type":"application/json","x-zm-trackingid":"v=2.0;clid=aw1;rid=WEB_${i.toString(16)}"}`,
          resp_body: `{"page_size":30,"meetings":[{"id":${i},"topic":"Topic ${i % 1000}"}]}`, resp_body_truncated: 0, resp_size: 60, resp_content_type: 'application/json',
          duration_ms: (i * 7919) % 2000, error: null, tracking_id: `v=2.0;clid=aw1;rid=WEB_${i.toString(16)}`, zoom_error_code: null, zoom_error_message: null,
          rl_category: 'Medium', rl_type: 'QPS', rl_limit: 60, rl_remaining: i % 60, rl_reset: null, retry_after: null, attempt: 1, retry_of: null, replay_of: null, redirects: null,
        });
      }
    })();
    const wh = h.app.ctx.services.webhooksRepo;
    db.transaction(() => {
      for (let i = 0; i < 100_000; i++) {
        const raw = Buffer.from(`{"event":"meeting.ev${i % 20}","event_ts":${t0 + i},"payload":{"account_id":"acc","object":{"id":${i}}}}`);
        wh.insert({ received_at: t0 + i * 20_000, profile_id: pid, slug: 'reports', method: 'POST', path: '/webhooks/zoom/reports', remote_ip: '127.0.0.1', event: `meeting.ev${i % 20}`, event_ts: t0 + i,
          account_id: 'acc', signature: i % 10 ? 'valid' : 'invalid', request_ts: '1', is_validation: 0, duplicate_of: null, duplicate_kind: null, body_hash: String(i), tracking_id: null,
          req_headers: '{}', raw_body: raw, raw_redacted: 0, payload: raw.toString(), response_status: i % 10 ? 200 : 401, response_body: null, error: null, handle_ms: (i % 50) / 10 });
      }
    })();

    const timed = async (path: string) => {
      const t = performance.now();
      const r = await h.admin.get(path);
      expect(r.status, path).toBe(200);
      return { ms: performance.now() - t, body: r.body };
    };
    const results: Record<string, number> = {};
    for (const p of [
      '/api/reports/calls?pageSize=50',
      '/api/reports/calls?pageSize=50&page=2000',
      '/api/reports/calls?pageSize=50&sort=duration_ms&dir=desc',
      '/api/reports/calls?pageSize=50&sort=url&dir=asc',
      '/api/reports/calls?pageSize=50&status=429',
      '/api/reports/calls?pageSize=50&statusClass=5xx&method=DELETE',
      `/api/reports/calls?pageSize=50&from=${t0 + 10 * 86400_000}&to=${t0 + 12 * 86400_000}`,
      '/api/reports/calls?pageSize=50&q=WEB_1f4a',
      '/api/reports/calls?pageSize=50&q=Topic%20999',
      '/api/reports/calls?pageSize=50&endpoint=meetings3',
      '/api/reports/calls/summary',
      `/api/reports/calls/summary?from=${t0 + 10 * 86400_000}&to=${t0 + 11 * 86400_000}`,
      '/api/reports/webhooks?pageSize=50',
      '/api/reports/webhooks?pageSize=50&signature=invalid&sort=event',
      '/api/reports/webhooks?pageSize=50&q=meeting.ev7',
      '/api/reports/webhooks/summary',
    ]) {
      results[p] = Math.round((await timed(p)).ms);
    }
    console.log('scale timings (ms):', results);
    const slow = Object.entries(results).filter(([, ms]) => ms > 1500);
    expect(slow, JSON.stringify(slow)).toEqual([]);
  }, 180_000);
});
