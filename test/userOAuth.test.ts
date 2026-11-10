import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, USER_CLIENT, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h?.close());

/** Drive the browser part of the flow: authorize URL -> mock consent -> portal callback. */
async function consent(authorizeUrl: string, mockUser?: string) {
  const u = new URL(authorizeUrl);
  if (mockUser) u.searchParams.set('mock_user', mockUser);
  const r1 = await fetch(u, { redirect: 'manual' });
  expect(r1.status).toBe(302);
  const callback = r1.headers.get('location')!;
  const r2 = await fetch(callback);
  return { callback, status: r2.status, html: await r2.text() };
}

async function makeProfile(name: string, usePkce: boolean) {
  const r = await h.admin.post('/api/profiles', { name, type: 'user', clientId: USER_CLIENT.clientId, clientSecret: USER_CLIENT.clientSecret, usePkce });
  expect(r.status).toBe(201);
  h.mock.clients.get(USER_CLIENT.clientId)!.redirectUris.push(r.body.urls.redirectUri);
  return r.body;
}

describe('user OAuth (authorization code) against mock Zoom', () => {
  let profile: any;
  let aliceAuthId: number;

  it('authorizes, labels the authorization from /users/me, and stores api_url', async () => {
    profile = await makeProfile('Mock User App', false);
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    expect(start.status).toBe(200);
    const au = new URL(start.body.authorizeUrl);
    expect(au.pathname).toBe('/oauth/authorize');
    expect(au.searchParams.get('redirect_uri')).toBe(profile.urls.redirectUri);
    expect(au.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    expect(au.searchParams.get('code_challenge')).toBeNull();

    const res = await consent(start.body.authorizeUrl);
    expect(res.status).toBe(200);
    expect(res.html).toContain('Authorized as Alice Admin');

    const p = await h.admin.get(`/api/profiles/${profile.id}`);
    const a = p.body.authorizations[0];
    aliceAuthId = a.id;
    expect(a).toMatchObject({ kind: 'user', status: 'active', zoomEmail: 'alice.admin@example.test', apiUrl: h.mockUrl, usedPkce: false });
    expect(a.scopes).toContain('user:read:user');
    expect(a.refreshTokenHint).toMatch(/^\[REDACTED\]…/);
  });

  it('rejects a replayed callback (state is single use)', async () => {
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    const res = await consent(start.body.authorizeUrl, 'mockuser002');
    expect(res.status).toBe(200);
    const replay = await fetch(res.callback);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('Invalid or expired state');
  });

  it('rejects a forged state and a callback for the wrong profile', async () => {
    const forged = await fetch(`${profile.urls.redirectUri}?code=abc&state=${'A'.repeat(43)}`);
    expect(forged.status).toBe(400);
    const other = await makeProfile('Other App', false);
    const start = await h.admin.post(`/api/profiles/${other.id}/authorize`, {});
    const u = new URL(start.body.authorizeUrl);
    const wrong = await fetch(`${profile.urls.redirectUri}?code=abc&state=${u.searchParams.get('state')}`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('State mismatch');
  });

  it('keeps one authorization per Zoom user: re-consent supersedes the old one', async () => {
    const p1 = await h.admin.get(`/api/profiles/${profile.id}`);
    const active1 = p1.body.authorizations.filter((a: any) => a.status === 'active');
    expect(active1.map((a: any) => a.zoomEmail).sort()).toEqual(['alice.admin@example.test', 'bob.builder@example.test']);

    const oldRow = h.app.ctx.services.auths.get(aliceAuthId)!;
    const oldRefresh = h.app.ctx.services.auths.refreshToken(oldRow)!;
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    await consent(start.body.authorizeUrl, 'mockuser001');
    const p2 = await h.admin.get(`/api/profiles/${profile.id}`);
    expect(p2.body.authorizations.find((a: any) => a.id === aliceAuthId).status).toBe('superseded');
    expect(p2.body.authorizations.filter((a: any) => a.status === 'active')).toHaveLength(2);
    expect(h.mock.refresh.has(oldRefresh)).toBe(false); // Zoom-side invalidation
    aliceAuthId = p2.body.authorizations.find((a: any) => a.status === 'active' && a.zoomEmail.startsWith('alice')).id;
  });

  it('sends a correct S256 PKCE challenge and verifier', async () => {
    const pk = await makeProfile('PKCE App', true);
    const start = await h.admin.post(`/api/profiles/${pk.id}/authorize`, {});
    const au = new URL(start.body.authorizeUrl);
    expect(au.searchParams.get('code_challenge_method')).toBe('S256');
    expect(au.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const res = await consent(start.body.authorizeUrl, 'mockuser003');
    expect(res.status).toBe(200);
    const p = await h.admin.get(`/api/profiles/${pk.id}`);
    expect(p.body.authorizations[0].usedPkce).toBe(true);
    // The token request must not have leaked the verifier into the log.
    const rows = h.app.ctx.db.prepare("SELECT req_body FROM api_calls WHERE category='token' AND grant_type='authorization_code'").all() as { req_body: string }[];
    expect(rows.some((r) => r.req_body.includes('code_verifier=[REDACTED]'))).toBe(true);
  });

  it('fails the exchange if the verifier is wrong (proves PKCE is enforced end to end)', async () => {
    const pk = await makeProfile('PKCE App 2', true);
    const start = await h.admin.post(`/api/profiles/${pk.id}/authorize`, {});
    h.app.ctx.db.prepare('UPDATE oauth_pending SET verifier_enc = ? WHERE profile_id = ?').run(h.app.ctx.cipher.encrypt('wrong-verifier-'.repeat(4), 'oauth_pending.verifier_enc'), pk.id);
    const res = await consent(start.body.authorizeUrl, 'mockuser004');
    expect(res.status).toBe(502);
    expect(res.html).toContain('Invalid code_verifier');
  });

  it('uses the stored redirect URI for the exchange even if the public URL changes mid-flow', async () => {
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    const base = h.app.ctx.settings.get().publicBaseUrlOverride;
    h.app.ctx.settings.update({ publicBaseUrlOverride: 'https://changed.example.test' });
    const res = await consent(start.body.authorizeUrl, 'mockuser002');
    h.app.ctx.settings.update({ publicBaseUrlOverride: base });
    expect(res.status).toBe(200);
  });

  it('supersedes the same Zoom user across profiles sharing a client ID', async () => {
    const dup = await makeProfile('Same App Copy', false);
    const start = await h.admin.post(`/api/profiles/${dup.id}/authorize`, {});
    await consent(start.body.authorizeUrl, 'mockuser003'); // PKCE App already holds mockuser003 for this client
    const pkce = (await h.admin.get('/api/profiles')).body.find((p: any) => p.name === 'PKCE App');
    const full = await h.admin.get(`/api/profiles/${pkce.id}`);
    expect(full.body.authorizations[0].status).toBe('superseded');
    expect(full.body.authorizations[0].statusDetail).toContain('Same App Copy');
  });

  it('rotates refresh tokens: new pair stored, old refresh token dead at Zoom', async () => {
    const svc = h.app.ctx.services;
    const before = svc.auths.get(aliceAuthId)!;
    const oldRt = svc.auths.refreshToken(before)!;
    const r = await h.admin.post(`/api/authorizations/${aliceAuthId}/refresh`, {});
    expect(r.status).toBe(200);
    const after = svc.auths.get(aliceAuthId)!;
    expect(after.version).toBe(before.version + 1);
    expect(svc.auths.refreshToken(after)).not.toBe(oldRt);
    expect(h.mock.refresh.has(oldRt)).toBe(false);
    expect(h.mock.refresh.has(svc.auths.refreshToken(after)!)).toBe(true);
  });

  it('coalesces a burst of concurrent refreshes into exactly one token call', async () => {
    const svc = h.app.ctx.services;
    h.mock.config.refreshDelayMs = 150;
    const row = svc.auths.get(aliceAuthId)!;
    const before = h.mock.stats.tokenRequests.refresh_token ?? 0;
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.tokens.renewAfterExpiry(row)));
    h.mock.config.refreshDelayMs = 0;
    expect((h.mock.stats.tokenRequests.refresh_token ?? 0) - before).toBe(1);
    expect(new Set(results.map((x) => x.accessToken)).size).toBe(1);
    const after = svc.auths.get(aliceAuthId)!;
    expect(after.status).toBe('active');
    expect(h.mock.refresh.has(svc.auths.refreshToken(after)!)).toBe(true);
  });

  it('serializes forced refreshes so none uses a rotated token', async () => {
    const svc = h.app.ctx.services;
    h.mock.config.refreshDelayMs = 50;
    const before = h.mock.stats.tokenRequests.refresh_token ?? 0;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.tokens.refreshUser(aliceAuthId, { force: true })));
    h.mock.config.refreshDelayMs = 0;
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((h.mock.stats.tokenRequests.refresh_token ?? 0) - before).toBe(5);
    expect(svc.auths.get(aliceAuthId)!.status).toBe('active');
  });

  it('marks the authorization failed when Zoom rejects the refresh token', async () => {
    const svc = h.app.ctx.services;
    const rt = svc.auths.refreshToken(svc.auths.get(aliceAuthId)!)!;
    h.mock.refresh.delete(rt);
    const r = await h.admin.post(`/api/authorizations/${aliceAuthId}/refresh`, {});
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('Invalid Token!');
    expect(svc.auths.get(aliceAuthId)!.status).toBe('failed');
    const ev = await h.admin.get(`/api/profiles/${profile.id}/token-events`);
    expect(ev.body[0]).toMatchObject({ kind: 'failed', grant_type: 'refresh_token', http_status: 400, error_code: 'invalid_request', error_message: 'Invalid Token!' });
  });

  it('records Zoom-side denial on the callback', async () => {
    const start = await h.admin.post(`/api/profiles/${profile.id}/authorize`, {});
    const state = new URL(start.body.authorizeUrl).searchParams.get('state');
    const r = await fetch(`${profile.urls.redirectUri}?error=access_denied&state=${state}`);
    expect(r.status).toBe(400);
    const ev = await h.admin.get(`/api/profiles/${profile.id}/token-events`);
    expect(ev.body[0]).toMatchObject({ kind: 'failed', error_code: 'access_denied' });
  });
});

describe('Marketplace-initiated installs (callback with code but no state)', () => {
  /** What Zoom's Marketplace "Add" / "Local Test" button does: no state, no PKCE. */
  async function marketplaceAdd(p: any, user: string) {
    const u = new URL(`${h.mockUrl}/oauth/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', USER_CLIENT.clientId);
    u.searchParams.set('redirect_uri', p.urls.redirectUri);
    u.searchParams.set('mock_user', user);
    const r1 = await fetch(u, { redirect: 'manual' });
    const cb = r1.headers.get('location')!;
    expect(new URL(cb).searchParams.has('state')).toBe(false);
    const r2 = await fetch(cb);
    return { status: r2.status, html: await r2.text() };
  }

  it('rejects by default with an explanation, and records why', async () => {
    const p = await makeProfile('Marketplace App', false);
    const r = await marketplaceAdd(p, 'mockuser005');
    expect(r.status).toBe(400);
    expect(r.html).toContain('Authorization started outside the portal');
    const ev = (await h.admin.get(`/api/profiles/${p.id}/token-events`)).body[0];
    expect(ev).toMatchObject({ kind: 'failed', error_code: 'no_state' });
    expect((await h.admin.get(`/api/profiles/${p.id}`)).body.authorizations).toHaveLength(0);
  });

  it('accepts when the profile opts in, and labels the authorization', async () => {
    const p = (await h.admin.get('/api/profiles')).body.find((x: any) => x.name === 'Marketplace App');
    const upd = await h.admin.put(`/api/profiles/${p.id}`, { acceptMarketplaceInstalls: true });
    expect(upd.body.acceptMarketplaceInstalls).toBe(true);
    const r = await marketplaceAdd(p, 'mockuser005');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Authorized as');
    const full = (await h.admin.get(`/api/profiles/${p.id}`)).body;
    expect(full.authorizations[0]).toMatchObject({ status: 'active', zoomEmail: 'user5.test@example.test', usedPkce: false });
    const ev = (await h.admin.get(`/api/profiles/${p.id}/token-events`)).body[0];
    expect(ev.detail).toContain('Marketplace-initiated');
  });

  it('still verifies state when one is present, even with the opt-in', async () => {
    const p = (await h.admin.get('/api/profiles')).body.find((x: any) => x.name === 'Marketplace App');
    const r = await fetch(`${p.urls.redirectUri}?code=abc&state=${'B'.repeat(43)}`);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Invalid or expired state');
  });

  it('reports a callback without a code', async () => {
    const p = (await h.admin.get('/api/profiles')).body.find((x: any) => x.name === 'Marketplace App');
    const r = await fetch(`${p.urls.redirectUri}?foo=1`);
    expect(r.status).toBe(400);
    const ev = (await h.admin.get(`/api/profiles/${p.id}/token-events`)).body[0];
    expect(ev).toMatchObject({ error_code: 'missing_code' });
    expect(ev.detail).toContain('foo');
  });
});

describe('tunnel URL change detection (fake ngrok forwarder)', () => {
  it('builds URLs from the tunnel and warns when an unreserved URL changes', async () => {
    const svc = h.app.ctx.services;
    h.app.ctx.settings.update({ publicBaseUrlOverride: '', lastPublicUrl: '' });
    svc.ctx.settings.setSecret('ngrokAuthtoken', 'fake-ngrok-authtoken-for-tests');
    let n = 0;
    let lastAddr = '';
    svc.tunnel.setForwarder(async (cfg) => {
      lastAddr = cfg.addr;
      const url = `https://random-${++n}.ngrok-free.app`;
      return { url: () => url, close: async () => {} };
    });
    let st = (await h.admin.post('/api/tunnel/start', {})).body;
    expect(lastAddr).toBe(new URL(h.publicUrl).host); // forwards only to the public listener
    expect(st).toMatchObject({ state: 'running', url: 'https://random-1.ngrok-free.app', urlChanged: false, ephemeralWarning: true });
    const prof = (await h.admin.get('/api/profiles')).body.find((p: any) => p.type === 'user');
    expect(prof.urls.redirectUri).toBe(`https://random-1.ngrok-free.app/oauth/callback/${prof.slug}`);

    await h.admin.post('/api/tunnel/stop', {});
    st = (await h.admin.post('/api/tunnel/start', {})).body;
    expect(st.url).toBe('https://random-2.ngrok-free.app');
    expect(st.urlChanged).toBe(true);
    expect(st.confirmedBase).toBe('https://random-1.ngrok-free.app');
    const fields = st.needsUpdate.filter((f: any) => f.profileId === prof.id).map((f: any) => f.field);
    expect(fields).toEqual(['OAuth Redirect URL', 'OAuth Allow List', 'Event Subscription — Event notification endpoint URL']);

    st = (await h.admin.post('/api/tunnel/acknowledge', {})).body;
    expect(st.urlChanged).toBe(false);
    await h.admin.post('/api/tunnel/stop', {});
  });

  it('refuses to authorize without a public URL', async () => {
    const prof = (await h.admin.get('/api/profiles')).body.find((p: any) => p.type === 'user');
    const r = await h.admin.post(`/api/profiles/${prof.id}/authorize`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('no_public_url');
  });
});
