import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { startHarness, S2S_CLIENT, WEBHOOK_SECRET, type Harness } from './helpers.js';
import { sendWebhook, sampleEvent, validationEvent, sign } from '../mock-zoom/webhookSender.js';

let h: Harness;
let url: string;
let profileId: number;
beforeAll(async () => {
  h = await startHarness();
  const r = await h.admin.post('/api/profiles', { name: 'Hooks', type: 's2s', clientId: S2S_CLIENT.clientId, clientSecret: S2S_CLIENT.clientSecret, accountId: 'mockaccount1', webhookSecret: WEBHOOK_SECRET });
  url = r.body.urls.webhookUrl;
  profileId = r.body.id;
});
afterAll(async () => h?.close());

const last = () => h.app.ctx.db.prepare('SELECT * FROM webhooks ORDER BY id DESC LIMIT 1').get() as any;

describe('webhook receiver', () => {
  it('answers a signed url_validation with the HMAC of plainToken', async () => {
    const body = JSON.stringify(validationEvent('plain-token-123'));
    const r = await sendWebhook({ url, secret: WEBHOOK_SECRET, body });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ plainToken: 'plain-token-123', encryptedToken: crypto.createHmac('sha256', WEBHOOK_SECRET).update('plain-token-123').digest('hex') });
    expect(last()).toMatchObject({ is_validation: 1, signature: 'valid', response_status: 200 });
  });

  it('refuses an unsigned url_validation (no HMAC oracle)', async () => {
    const attackerChosen = `v0:${Math.floor(Date.now() / 1000)}:{"event":"meeting.deleted"}`;
    const r = await sendWebhook({ url, secret: WEBHOOK_SECRET, noSignature: true, body: JSON.stringify(validationEvent(attackerChosen)) });
    expect(r.status).toBe(401);
    expect(r.body).not.toMatch(/[0-9a-f]{64}/);
    expect(last()).toMatchObject({ is_validation: 1, signature: 'missing', response_status: 401 });
  });

  it('accepts a valid event and stores the raw body byte-for-byte', async () => {
    const body = '{ "event":"meeting.started",\n "event_ts": 1731230000000, "payload":{"account_id":"mockaccount1","object":{"topic":"ünïcødé"}} }';
    const r = await sendWebhook({ url, secret: WEBHOOK_SECRET, body });
    expect(r.status).toBe(200);
    const row = last();
    expect(Buffer.from(row.raw_body).toString('utf8')).toBe(body);
    expect(row).toMatchObject({ event: 'meeting.started', event_ts: 1731230000000, account_id: 'mockaccount1', signature: 'valid', duplicate_of: null, profile_id: profileId });
    expect(row.tracking_id).toMatch(/^v=2\.0;clid=mock;rid=WEB_/);
    expect(JSON.parse(row.payload).payload.object.topic).toBe('ünïcødé');
  });

  it('records and rejects bad signatures, missing headers, tampering and stale timestamps', async () => {
    const cases = [
      [{ badSignature: true }, 'invalid'],
      [{ noSignature: true }, 'missing'],
      [{ tamper: true }, 'invalid'],
      [{ ageSec: 600 }, 'stale'],
    ] as const;
    for (const [o, expected] of cases) {
      const r = await sendWebhook({ url, secret: WEBHOOK_SECRET, ...o });
      expect(r.status, expected).toBe(401);
      expect(last().signature).toBe(expected);
    }
  });

  it('honours the configured replay tolerance', async () => {
    h.app.ctx.settings.update({ webhookToleranceSec: 900 });
    expect((await sendWebhook({ url, secret: WEBHOOK_SECRET, ageSec: 600 })).status).toBe(200);
    h.app.ctx.settings.update({ webhookToleranceSec: 300 });
  });

  it('flags retries (identical body) and same event_ts re-deliveries as duplicates without hiding them', async () => {
    const body = JSON.stringify(sampleEvent('meeting.ended', { event_ts: 1731231111111 }));
    await sendWebhook({ url, secret: WEBHOOK_SECRET, body });
    const first = last().id;
    const r2 = await sendWebhook({ url, secret: WEBHOOK_SECRET, body });
    expect(r2.status).toBe(200);
    expect(last()).toMatchObject({ duplicate_of: first, duplicate_kind: 'identical_body' });
    const variant = JSON.stringify({ ...JSON.parse(body), payload: { account_id: 'mockaccount1', object: { id: 'changed' } } });
    await sendWebhook({ url, secret: WEBHOOK_SECRET, body: variant });
    expect(last()).toMatchObject({ duplicate_of: first, duplicate_kind: 'same_event_ts' });
  });

  it('records unknown profiles, other methods and malformed JSON', async () => {
    let r = await sendWebhook({ url: url.replace(/[^/]+$/, 'nope'), secret: WEBHOOK_SECRET });
    expect(r.status).toBe(404);
    expect(last()).toMatchObject({ signature: 'unknown_profile', slug: 'nope' });
    const g = await fetch(url);
    expect(g.status).toBe(405);
    expect(last()).toMatchObject({ signature: 'not_post', method: 'GET' });
    const ts = String(Math.floor(Date.now() / 1000));
    const bad = '{"event": nope';
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': sign(WEBHOOK_SECRET, ts, bad) }, body: bad });
    expect(res.status).toBe(400);
    expect(last()).toMatchObject({ signature: 'valid', response_status: 400 });
    expect(last().error).toMatch(/Invalid JSON/);
  });

  it('verifies non-JSON content types over raw bytes too', async () => {
    const body = JSON.stringify(sampleEvent());
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-zm-request-timestamp': ts, 'x-zm-signature': sign(WEBHOOK_SECRET, ts, body) }, body });
    expect(r.status).toBe(200);
  });

  it('pushes webhooks to the admin UI over SSE', async () => {
    const u = new URL(h.adminUrl);
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: u.hostname, port: u.port, path: '/api/stream', headers: { cookie: h.admin.cookie } }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('event: webhook')) {
            req.destroy();
            resolve(buf);
          }
        });
        setTimeout(() => sendWebhook({ url, secret: WEBHOOK_SECRET, event: 'recording.completed' }), 50);
      });
      req.on('error', (e) => (e.message.includes('aborted') || (e as any).code === 'ECONNRESET' ? null : reject(e)));
      setTimeout(() => reject(new Error('no SSE event')), 3000);
    });
    expect(got).toContain('"event":"recording.completed"');
  });

  it('answers quickly', async () => {
    const t = performance.now();
    await sendWebhook({ url, secret: WEBHOOK_SECRET });
    expect(performance.now() - t).toBeLessThan(200);
    expect(last().handle_ms).toBeLessThan(50);
  });

  it('never stores the secret token or signature-check secrets in headers', () => {
    const dump = JSON.stringify(h.app.ctx.db.prepare('SELECT req_headers, payload, error FROM webhooks').all());
    expect(dump).not.toContain(WEBHOOK_SECRET);
  });
});
