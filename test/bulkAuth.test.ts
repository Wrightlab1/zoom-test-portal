import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, USER_CLIENT, type Harness } from './helpers.js';
import { TOKEN_EXCHANGE_GRANT } from '../server/services/bulkAuth.js';

/**
 * Admin authorization for users and groups (code_type=bulk), against the mock:
 * bulk code -> bulk access token -> paged RFC 8693 token exchange -> one authorization per user.
 */
let h: Harness;
let profile: any;

beforeAll(async () => {
  h = await startHarness();
  h.app.ctx.settings.update({ bulkFirstFetchDelaySec: 0, bulkBatchSize: 20 });
  const r = await h.admin.post('/api/profiles', { name: 'Bulk App', type: 'user', clientId: USER_CLIENT.clientId, clientSecret: USER_CLIENT.clientSecret });
  expect(r.status).toBe(201);
  profile = r.body;
  h.mock.clients.get(USER_CLIENT.clientId)!.redirectUris.push(profile.urls.redirectUri);
});
afterAll(async () => h?.close());

/** What Zoom does after an admin picks Add for others -> Users and groups: redirect with code + code_type=bulk, no state. */
async function adminAddForOthers(q: Record<string, string>) {
  const u = new URL(`${h.mockUrl}/__mock_admin/bulk-authorize`);
  u.searchParams.set('client_id', USER_CLIENT.clientId);
  u.searchParams.set('redirect_uri', profile.urls.redirectUri);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const r1 = await fetch(u, { redirect: 'manual' });
  expect(r1.status).toBe(302);
  const callback = r1.headers.get('location')!;
  const cu = new URL(callback);
  expect(cu.searchParams.get('code_type')).toBe('bulk');
  expect(cu.searchParams.has('state')).toBe(false);
  const r2 = await fetch(callback);
  return { callback, status: r2.status, html: await r2.text() };
}

async function grants(): Promise<any[]> {
  return (await h.admin.get(`/api/profiles/${profile.id}/bulk-grants`)).body;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

describe('admin authorization for users and groups (code_type=bulk)', () => {
  it('is rejected without the Marketplace opt-in, before any token request', async () => {
    const before = h.mock.stats.tokenRequests.authorization_code ?? 0;
    const r = await adminAddForOthers({ count: '3' });
    expect(r.status).toBe(400);
    expect(r.html).toContain('Admin authorization rejected');
    expect(h.mock.stats.tokenRequests.authorization_code ?? 0).toBe(before);
    const ev = (await h.admin.get(`/api/profiles/${profile.id}/token-events`)).body[0];
    expect(ev).toMatchObject({ kind: 'failed', error_code: 'no_state' });
    expect(ev.detail).toContain('code_type=bulk');
    expect(await grants()).toHaveLength(0);
  });

  let grantId: number;

  it('exchanges the bulk code, then pages through user tokens until has_more=false', async () => {
    await h.admin.put(`/api/profiles/${profile.id}`, { acceptMarketplaceInstalls: true });
    const r = await adminAddForOthers({ count: '45' });
    expect(r.status).toBe(200);
    expect(r.html).toContain('Admin authorization received');

    const g = await waitFor(async () => (await grants()).find((x) => x.status === 'complete'));
    grantId = g.id;
    expect(g).toMatchObject({ tokenType: 'bulk_access_token', batchSize: 20, pages: 3, usersReceived: 45, apiUrl: h.mockUrl, authorizations: { active: 45, other: 0 } });
    expect(g.bulkTokenHint).toMatch(/^\[REDACTED\]…/);

    const full = (await h.admin.get(`/api/profiles/${profile.id}`)).body;
    const bulkAuths = full.authorizations.filter((a: any) => a.bulkGrantId === g.id);
    expect(bulkAuths).toHaveLength(45);
    expect(bulkAuths.every((a: any) => a.status === 'active' && a.kind === 'user' && a.apiUrl === h.mockUrl && a.refreshTokenHint)).toBe(true);
    expect(bulkAuths.map((a: any) => a.zoomEmail)).toContain('alice.admin@example.test');
    expect(bulkAuths.map((a: any) => a.zoomEmail)).toContain('user45.test@example.test');

    const kinds = (await h.admin.get(`/api/profiles/${profile.id}/token-events`)).body.map((e: any) => e.kind);
    expect(kinds.filter((k: string) => k === 'bulk_page')).toHaveLength(3);
    expect(kinds).toContain('bulk_issued');
    expect(kinds).toContain('bulk_complete');
    // Exactly the requests the docs describe: one code exchange and one exchange per page.
    expect(h.mock.stats.tokenRequests[TOKEN_EXCHANGE_GRANT]).toBe(3);
  });

  it('stores user tokens that work and refresh like any user authorization', async () => {
    const svc = h.app.ctx.services;
    const row = svc.auths.listForProfile(profile.id).find((a) => a.bulk_grant_id === grantId && a.zoom_email === 'bob.builder@example.test')!;
    const refreshed = await svc.tokens.refreshUser(row.id, { force: true, reason: 'test' });
    expect(refreshed.version).toBe(row.version + 1);
    const res = await fetch(`${h.mockUrl}/v2/users/me`, { headers: { Authorization: `Bearer ${svc.auths.accessToken(refreshed)}` } });
    expect((await res.json()).email).toBe('bob.builder@example.test');
  });

  it('never logs the bulk token or the per-user tokens', async () => {
    const svc = h.app.ctx.services;
    const bulkToken = svc.bulkGrants.bulkToken(svc.bulkGrants.get(grantId)!)!;
    expect(bulkToken).toMatch(/^bt_/);
    const rows = h.app.ctx.db.prepare('SELECT req_body, resp_body FROM api_calls WHERE grant_type IN (?, ?)').all(TOKEN_EXCHANGE_GRANT, 'authorization_code') as { req_body: string; resp_body: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(bulkToken);
    expect(blob).toContain('subject_token=[REDACTED]');
    for (const a of svc.auths.listForProfile(profile.id).filter((x) => x.bulk_grant_id === grantId).slice(0, 10)) {
      const at = svc.auths.accessToken(a);
      if (at) expect(blob).not.toContain(at);
    }
    expect(blob).not.toMatch(/mock_at_[A-Za-z0-9_-]{20}/);
    expect(blob).not.toMatch(/mock_rt_[A-Za-z0-9_-]{20}/);
  });

  it('"Fetch again" re-runs the grant and supersedes the tokens from the previous pass', async () => {
    const r = await h.admin.post(`/api/bulk-grants/${grantId}/fetch`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'complete', pages: 3, usersReceived: 45, authorizations: { active: 45, other: 45 } });
    const full = (await h.admin.get(`/api/profiles/${profile.id}`)).body;
    const active = full.authorizations.filter((a: any) => a.status === 'active');
    expect(new Set(active.map((a: any) => a.zoomEmail)).size).toBe(active.length); // one live authorization per user
  });

  it('a user who later authorizes from the portal supersedes their bulk authorization (matched by email)', async () => {
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    const u = new URL(start.body.authorizeUrl);
    u.searchParams.set('mock_user', 'mockuser003');
    const cb = (await fetch(u, { redirect: 'manual' })).headers.get('location')!;
    expect((await fetch(cb)).status).toBe(200);
    const all = h.app.ctx.services.auths.listForProfile(profile.id).filter((a) => a.zoom_email === 'user3.test@example.test');
    const live = all.filter((a) => a.status === 'active');
    expect(live).toHaveLength(1);
    expect(live[0].bulk_grant_id).toBeNull();
    expect(live[0].zoom_user_id).toBe('mockuser003');
  });

  it('waits and retries while Zoom is still preparing user tokens', async () => {
    h.mock.config.bulkPrepMs = 60_000;
    const r = await adminAddForOthers({ users: 'mockuser050,mockuser051' });
    expect(r.status).toBe(200);
    const g = await waitFor(async () => (await grants()).find((x) => x.id !== grantId && x.status === 'waiting' && x.attempts === 1));
    expect(g.lastError).toContain('being prepared');
    expect(g.nextAttemptAt).toBeGreaterThan(Date.now() + 20_000);
    expect(g.usersReceived).toBe(0);

    h.mock.config.bulkPrepMs = 0; // tokens are ready now
    const done = await h.admin.post(`/api/bulk-grants/${g.id}/fetch`, {});
    expect(done.body).toMatchObject({ status: 'complete', usersReceived: 2, pages: 1, lastError: null, nextAttemptAt: null });
  });

  it('reports a failed bulk code exchange (code reused)', async () => {
    const r = await adminAddForOthers({ users: 'mockuser052' });
    expect(r.status).toBe(200);
    const again = await fetch(r.callback);
    expect(again.status).toBe(502);
    expect(await again.text()).toContain('Bulk token exchange failed');
  });

  it('still verifies state when one is present on a bulk callback', async () => {
    const r = await fetch(`${profile.urls.redirectUri}?code=abc&code_type=bulk&state=${'C'.repeat(43)}`);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Invalid or expired state');
  });

  it('marks an expired bulk grant and forgets its token', async () => {
    const svc = h.app.ctx.services;
    const g = svc.bulkGrants.listForProfile(profile.id)[0];
    h.app.ctx.db.prepare('UPDATE bulk_grants SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, g.id);
    svc.bulk.sweepExpired();
    expect(svc.bulkGrants.bulkToken(svc.bulkGrants.get(g.id)!)).toBeNull();
    const r = await h.admin.post(`/api/bulk-grants/${g.id}/fetch`, {});
    expect(r.status).toBe(409);
  });

  it('deleting a grant keeps the user authorizations it produced', async () => {
    const before = h.app.ctx.services.auths.listForProfile(profile.id).filter((a) => a.bulk_grant_id === grantId).length;
    expect((await h.admin.del(`/api/bulk-grants/${grantId}`)).status).toBe(200);
    const after = h.app.ctx.services.auths.listForProfile(profile.id);
    expect(after.filter((a) => a.bulk_grant_id === grantId)).toHaveLength(0);
    expect(after.length).toBeGreaterThanOrEqual(before);
  });
});
