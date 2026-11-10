import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, S2S_CLIENT, WEBHOOK_SECRET, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.close());

describe('profiles + Server-to-Server tokens (against mock Zoom)', () => {
  let profileId: number;

  it('creates a profile without ever echoing secrets', async () => {
    const r = await h.admin.post('/api/profiles', {
      name: 'Mock S2S',
      type: 's2s',
      clientId: S2S_CLIENT.clientId,
      clientSecret: S2S_CLIENT.clientSecret,
      accountId: S2S_CLIENT.accountId,
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(r.status).toBe(201);
    profileId = r.body.id;
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(S2S_CLIENT.clientSecret);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(r.body.clientSecretHint).toMatch(/…0001$/);
    expect(r.body.urls.webhookUrl).toBe(`${h.publicUrl}/webhooks/zoom/mock-s2s`);
    const list = await h.admin.get('/api/profiles');
    expect(JSON.stringify(list.body)).not.toContain(S2S_CLIENT.clientSecret);
  });

  it('stores secrets encrypted at rest', () => {
    const row = h.app.ctx.db.prepare('SELECT client_secret_enc, webhook_secret_enc FROM profiles WHERE id = ?').get(profileId) as Record<string, string>;
    expect(row.client_secret_enc.startsWith('v1:')).toBe(true);
    expect(row.client_secret_enc).not.toContain(S2S_CLIENT.clientSecret);
  });

  it('keeps the secret when an edit omits it (write-only field)', async () => {
    const r = await h.admin.put(`/api/profiles/${profileId}`, { notes: 'edited' });
    expect(r.body.clientSecretHint).toMatch(/…0001$/);
  });

  it('gets, caches and force-renews an S2S token with api_url', async () => {
    const r1 = await h.admin.post(`/api/profiles/${profileId}/s2s-token`, { force: false });
    expect(r1.status).toBe(200);
    expect(r1.body.apiUrl).toBe(h.mockUrl);
    expect(r1.body.accessExpiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(JSON.stringify(r1.body)).not.toMatch(/mock_at_/);
    const before = h.mock.stats.tokenRequests.account_credentials;
    await h.admin.post(`/api/profiles/${profileId}/s2s-token`, { force: false });
    expect(h.mock.stats.tokenRequests.account_credentials).toBe(before); // cached
    const r3 = await h.admin.post(`/api/profiles/${profileId}/s2s-token`, { force: true });
    expect(h.mock.stats.tokenRequests.account_credentials).toBe(before + 1);
    expect(r3.body.version).toBeGreaterThan(r1.body.version);
  });

  it('coalesces concurrent S2S requests into one token call', async () => {
    const before = h.mock.stats.tokenRequests.account_credentials;
    h.app.ctx.db.prepare("UPDATE authorizations SET access_expires_at = ? WHERE profile_id = ?").run(Date.now() + 1000, profileId);
    await Promise.all(Array.from({ length: 8 }, () => h.app.ctx.services.tokens.s2sToken(profileId)));
    expect(h.mock.stats.tokenRequests.account_credentials).toBe(before + 1);
  });

  it('reveals a token only through the explicit reveal action', async () => {
    const p = await h.admin.get(`/api/profiles/${profileId}`);
    const authId = p.body.authorizations[0].id;
    const r = await h.admin.post(`/api/authorizations/${authId}/reveal`, { field: 'access_token' });
    expect(r.body.value).toMatch(/^mock_at_/);
  });

  it('logs token calls with secrets redacted', () => {
    const rows = h.app.ctx.db.prepare("SELECT * FROM api_calls WHERE category = 'token'").all() as Record<string, string>[];
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(S2S_CLIENT.clientSecret);
    expect(dump).not.toContain(Buffer.from(`${S2S_CLIENT.clientId}:${S2S_CLIENT.clientSecret}`).toString('base64'));
    expect(dump).not.toMatch(/mock_at_[A-Za-z0-9_-]{20}/);
    expect(rows[0].grant_type).toBe('account_credentials');
    expect(rows[0].tracking_id).toMatch(/^v=2\.0;clid=mock/);
  });

  it('records a failed token event with Zoom’s error', async () => {
    const bad = await h.admin.post('/api/profiles', { name: 'Bad S2S', type: 's2s', clientId: S2S_CLIENT.clientId, clientSecret: 'wrong-secret-value', accountId: 'mockaccount1' });
    const r = await h.admin.post(`/api/profiles/${bad.body.id}/s2s-token`, {});
    expect(r.status).toBe(502);
    expect(r.body.message).toContain('Invalid client_id or client_secret');
    const ev = await h.admin.get(`/api/profiles/${bad.body.id}/token-events`);
    expect(ev.body[0]).toMatchObject({ kind: 'failed', http_status: 401, error_code: 'invalid_client' });
  });

  it('revokes', async () => {
    const p = await h.admin.get(`/api/profiles/${profileId}`);
    const authId = p.body.authorizations[0].id;
    const r = await h.admin.post(`/api/authorizations/${authId}/revoke`, {});
    expect(r.body.status).toBe('revoked');
    expect(h.mock.stats.revokes).toBe(1);
  });

  it('duplicates and deletes profiles', async () => {
    const d = await h.admin.post(`/api/profiles/${profileId}/duplicate`, {});
    expect(d.body.slug).toBe('mock-s2s-copy');
    expect(d.body.clientSecretHint).toMatch(/…0001$/);
    expect((await h.admin.del(`/api/profiles/${d.body.id}`)).status).toBe(200);
  });
});

describe('admin API protection', () => {
  it('requires a session, a CSRF token and a loopback Host', async () => {
    const anon = await fetch(h.adminUrl + '/api/profiles');
    expect(anon.status).toBe(401);
    const noCsrf = await fetch(h.adminUrl + '/api/profiles', { method: 'POST', headers: { cookie: h.admin.cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const badOrigin = await fetch(h.adminUrl + '/api/profiles', {
      method: 'POST',
      headers: { cookie: h.admin.cookie, 'x-csrf-token': h.admin.csrf, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    // fetch() cannot override Host, so use node:http for the DNS-rebinding case.
    const u = new URL(h.adminUrl);
    const status = await new Promise<number>((resolve) => {
      http.get({ host: u.hostname, port: u.port, path: '/api/auth/status', headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(421);
  });

  it('sets an HttpOnly SameSite=Strict session cookie', async () => {
    const r = await fetch(h.adminUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const sc = r.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
  });

  it('public listener exposes nothing from the admin API', async () => {
    for (const p of ['/', '/api/profiles', '/api/auth/status', '/index.html', '/webhooks', '/oauth/callback']) {
      const r = await fetch(h.publicUrl + p);
      expect(r.status, p).toBe(404);
    }
  });
});
