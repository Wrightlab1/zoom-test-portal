import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { startHarness, S2S_CLIENT, USER_CLIENT, type Harness } from './helpers.js';
import { MEETING_UUID } from '../mock-zoom/mock.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/zoom-collection.sample.json', import.meta.url), 'utf8'));
let h: Harness;
let s2s: any;
let user: any;
let collectionId: number;

beforeAll(async () => {
  h = await startHarness();
  s2s = (await h.admin.post('/api/profiles', { name: 'Explorer S2S', type: 's2s', clientId: S2S_CLIENT.clientId, clientSecret: S2S_CLIENT.clientSecret, accountId: 'mockaccount1' })).body;
  user = (await h.admin.post('/api/profiles', { name: 'Explorer User', type: 'user', clientId: USER_CLIENT.clientId, clientSecret: USER_CLIENT.clientSecret })).body;
  h.mock.clients.get(USER_CLIENT.clientId)!.redirectUris.push(user.urls.redirectUri);
  const start = await h.admin.post(`/api/profiles/${user.id}/authorize`, {});
  const r1 = await fetch(start.body.authorizeUrl, { redirect: 'manual' });
  await fetch(r1.headers.get('location')!);
});
afterAll(async () => h?.close());

const send = (body: Record<string, unknown>) => h.admin.post('/api/send', { profileId: s2s.id, method: 'GET', ...body });

describe('Postman import', () => {
  it('imports a collection and serves a compact tree and full definitions', async () => {
    const r = await h.admin.post('/api/collections/import', { collection: fixture });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: true, added: 9, updated: 0, removed: 0, folders: 4 });
    collectionId = r.body.collectionId;
    const tree = await h.admin.get(`/api/collections/${collectionId}/tree`);
    expect(tree.body.requests).toHaveLength(9);
    expect(tree.body.requests[0]).toEqual({ id: expect.any(Number), folderId: expect.any(Number), name: 'List meetings', method: 'GET', path: '/users/:userId/meetings', sort: expect.any(Number) });
    const def = await h.admin.get(`/api/collection-requests/${tree.body.requests[0].id}`);
    expect(def.body.definition.examples).toHaveLength(2);
  });

  it('re-import updates in place and keeps saved requests (orphaned, then re-linked)', async () => {
    const tree = (await h.admin.get(`/api/collections/${collectionId}/tree`)).body;
    const getMeeting = tree.requests.find((r: any) => r.name === 'Get a meeting');
    const listUsers = tree.requests.find((r: any) => r.name === 'List users');
    const saved1 = await h.admin.post('/api/saved-requests', { name: 'My meeting', collectionRequestId: getMeeting.id, request: { method: 'GET', url: '{{baseUrl}}/meetings/:meetingId', pathVariables: { meetingId: '123' } } });
    const saved2 = await h.admin.post('/api/saved-requests', { name: 'Active users', collectionRequestId: listUsers.id, request: { method: 'GET', url: '{{baseUrl}}/users' } });

    const v2 = structuredClone(fixture);
    const meetings = v2.item[0].item[0].item;
    meetings.splice(meetings.findIndex((i: any) => i.name === 'Get a meeting'), 1); // removed
    meetings.push({ name: 'Delete a meeting', request: { method: 'DELETE', url: '{{baseUrl}}/meetings/:meetingId' } }); // added
    v2.item[1].item[0].request.description = 'Updated description'; // List users changed
    const r = await h.admin.post('/api/collections/import', { collection: v2 });
    expect(r.body).toMatchObject({ created: false, collectionId, added: 1, removed: 1, updated: 1, orphanedSavedRequests: 1 });

    const saved = (await h.admin.get('/api/saved-requests')).body;
    expect(saved.find((x: any) => x.id === saved1.body.id)).toMatchObject({ orphaned: true, request: { pathVariables: { meetingId: '123' } } });
    expect(saved.find((x: any) => x.id === saved2.body.id)).toMatchObject({ orphaned: false, collectionRequestId: listUsers.id });

    const back = await h.admin.post('/api/collections/import', { collection: fixture });
    expect(back.body).toMatchObject({ relinkedSavedRequests: 1, orphanedSavedRequests: 0 });
  });

  it('imports environments and hides secret-typed values', async () => {
    const env = JSON.parse(fs.readFileSync(new URL('./fixtures/zoom-environment.sample.json', import.meta.url), 'utf8'));
    const r = await h.admin.post('/api/environments/import', { environment: env });
    expect(r.body.created).toBe(true);
    const bt = r.body.environment.values.find((v: any) => v.key === 'bearerToken');
    expect(bt).toMatchObject({ value: '', hasValue: true, type: 'secret' });
  });

  it('rejects garbage', async () => {
    expect((await h.admin.post('/api/collections/import', { collection: { hello: 'world' } })).status).toBe(400);
  });
});

describe('API explorer (backend proxy)', () => {
  it('attaches the token server-side, resolves {{baseUrl}} from api_url and logs everything', async () => {
    const r = await send({ url: '{{baseUrl}}/users', query: [{ key: 'page_size', value: '20', enabled: true }, { key: 'status', value: 'x', enabled: false }] });
    expect(r.status).toBe(200);
    const c = r.body.calls[0];
    expect(c.url).toBe(`${h.mockUrl}/v2/users?page_size=20`);
    expect(c.status).toBe(200);
    expect(c.endpoint).toBe('/users');
    expect(c.requestHeaders.Authorization).toMatch(/^Bearer \[REDACTED\]…/);
    expect(c.trackingId).toMatch(/^v=2\.0/);
    expect(c.rateLimit).toMatchObject({ category: 'Medium', type: 'QPS', limit: 80, remaining: 55 });
    expect(JSON.parse(c.responseBody).users).toHaveLength(20);
  });

  it('paginates with next_page_token', async () => {
    let token = '';
    const all: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await send({ url: '{{baseUrl}}/users', query: [{ key: 'page_size', value: '25', enabled: true }, ...(token ? [{ key: 'next_page_token', value: token, enabled: true }] : [])] });
      const b = JSON.parse(r.body.calls[0].responseBody);
      all.push(...b.users.map((u: any) => u.id));
      token = b.next_page_token;
      if (!token) break;
    }
    expect(all).toHaveLength(57);
    expect(new Set(all).size).toBe(57);
  });

  it('double-encodes meeting UUIDs that start with / or contain //', async () => {
    const ok = await send({ url: '{{baseUrl}}/past_meetings/:meetingId', pathVariables: { meetingId: MEETING_UUID } });
    expect(ok.body.calls[0].status).toBe(200);
    expect(ok.body.calls[0].url).toContain('%252Fabc%252Bdef%252F%252Fghi%253D%253D');
    expect(ok.body.calls[0].endpoint).toBe('/past_meetings/:meetingId');
    const single = await send({ url: '{{baseUrl}}/past_meetings/:meetingId', pathVariables: { meetingId: MEETING_UUID }, encoding: { meetingId: 'single' } });
    expect(single.body.calls[0].status).toBe(404);
  });

  it('surfaces 429 rate-limit details', async () => {
    const r = await send({ url: '{{baseUrl}}/ratelimit-test' });
    const c = r.body.calls[0];
    expect(c.status).toBe(429);
    expect(c.rateLimit).toMatchObject({ category: 'Heavy', remaining: 0 });
    expect(c.rateLimit.retryAfter).toBeTruthy();
    expect(c.zoomErrorCode).toBe('429');
  });

  it('on 401 "expired" re-requests the S2S token once and retries once (both logged)', async () => {
    await send({ url: '{{baseUrl}}/users' }); // ensure a cached token
    h.mock.expireAll();
    const before = h.mock.stats.tokenRequests.account_credentials;
    const r = await send({ url: '{{baseUrl}}/users' });
    expect(r.body.calls.map((c: any) => c.status)).toEqual([401, 200]);
    expect(r.body.calls[1]).toMatchObject({ attempt: 2, retryOf: r.body.calls[0].id });
    expect(r.body.calls[0].zoomErrorMessage).toBe('Access token is expired.');
    expect(h.mock.stats.tokenRequests.account_credentials).toBe(before + 1);
  });

  it('on 401 "expired" refreshes the user token once and retries once', async () => {
    const auth = (await h.admin.get(`/api/profiles/${user.id}`)).body.authorizations[0];
    h.mock.expireAll();
    const before = h.mock.stats.tokenRequests.refresh_token ?? 0;
    const r = await h.admin.post('/api/send', { profileId: user.id, authorizationId: auth.id, method: 'GET', url: '{{baseUrl}}/users/me' });
    expect(r.body.calls.map((c: any) => c.status)).toEqual([401, 200]);
    expect((h.mock.stats.tokenRequests.refresh_token ?? 0) - before).toBe(1);
    const ev = (await h.admin.get(`/api/profiles/${user.id}/token-events`)).body[0];
    expect(ev).toMatchObject({ kind: 'refreshed', detail: '401 access token expired' });
  });

  it('does not retry an invalid (not expired) token', async () => {
    const auth = (await h.admin.get(`/api/profiles/${user.id}`)).body.authorizations[0];
    h.mock.access.clear(); // tokens unknown to Zoom -> "Invalid access token."
    const r = await h.admin.post('/api/send', { profileId: user.id, authorizationId: auth.id, method: 'GET', url: '{{baseUrl}}/users/me' });
    expect(r.body.calls).toHaveLength(1);
    expect(r.body.calls[0].status).toBe(401);
    await h.admin.post(`/api/authorizations/${auth.id}/refresh`, {});
    await h.admin.post(`/api/profiles/${s2s.id}/s2s-token`, { force: true });
  });

  it('blocks non-allowlisted hosts and logs the attempt', async () => {
    const r = await send({ url: 'https://example.com/v2/users' });
    const c = r.body.calls[0];
    expect(c.status).toBeNull();
    expect(c.error).toMatch(/Blocked by outbound allowlist/);
    expect(r.body.warnings.some((w: string) => w.includes('not in the outbound allowlist'))).toBe(true);
  });

  it('follows allowlisted redirects and records the chain', async () => {
    const r = await send({ url: '{{baseUrl}}/recordings/download' });
    const c = r.body.calls[0];
    expect(c.status).toBe(200);
    expect(c.redirects).toEqual([{ status: 302, location: `${h.mockUrl}/rec/file/mock.bin` }]);
    expect(c.responseBody).toMatch(/^\[binary body: 2048 bytes/);
  });

  it('warns about S2S + me, ignored Authorization headers, and unresolved variables', async () => {
    const r = await send({ url: '{{baseUrl}}/users/me?x={{nope}}', headers: [{ key: 'Authorization', value: 'Bearer mine', enabled: true }] });
    const w = r.body.warnings.join('\n');
    expect(w).toContain('must not use "me"');
    expect(w).toContain('Ignored your Authorization header');
    expect(w).toContain('{{nope}}');
  });

  it('can send without auth (own Authorization header) for negative tests', async () => {
    const r = await send({ auth: 'none', url: '{{baseUrl}}/users', headers: [{ key: 'Authorization', value: 'Bearer deliberately-bad-token-123', enabled: true }] });
    expect(r.body.calls[0].status).toBe(401);
    expect(r.body.calls[0].requestHeaders.Authorization).not.toContain('deliberately-bad');
  });

  it('sends JSON bodies with environment variables', async () => {
    const env = (await h.admin.get('/api/environments')).body[0];
    const r = await send({ method: 'POST', url: '{{baseUrl}}/users/me/meetings', environmentId: env.id, body: '{"topic":"from {{clientId}}","type":2}' });
    expect(r.body.calls[0].status).toBe(201);
    expect(r.body.calls[0].requestBody).toBe('{"topic":"from fixture-client-id","type":2}');
    expect(r.body.calls[0].requestHeaders['Content-Type']).toBe('application/json');
  });

  it('copies as curl with the token redacted unless revealed', async () => {
    const r = await send({ url: '{{baseUrl}}/users' });
    const id = r.body.calls[0].id;
    const red = (await h.admin.get(`/api/calls/${id}/curl`)).body.curl;
    expect(red).toContain('-H "Authorization: Bearer $ZOOM_ACCESS_TOKEN"');
    expect(red).not.toMatch(/mock_at_/);
    const rev = (await h.admin.get(`/api/calls/${id}/curl?reveal=1`)).body.curl;
    expect(rev).toMatch(/Authorization: Bearer mock_at_/);
    const pre = (await h.admin.post('/api/send/curl', { profileId: s2s.id, method: 'GET', url: '{{baseUrl}}/users', reveal: false })).body;
    expect(pre.curl).toContain(`'${h.mockUrl}/v2/users'`);
    expect(pre.curl).toContain('$ZOOM_ACCESS_TOKEN');
  });

  it('re-runs a past call from the log', async () => {
    const first = (await send({ url: '{{baseUrl}}/past_meetings/:meetingId', pathVariables: { meetingId: MEETING_UUID } })).body.calls[0];
    const r = await h.admin.post(`/api/calls/${first.id}/replay`, {});
    expect(r.body.calls[0]).toMatchObject({ status: 200, replayOf: first.id, url: first.url });
  });

  it('never writes a raw token into the log tables', () => {
    const tokens = [...h.mock.access.keys(), ...h.mock.refresh.keys()];
    const dump = JSON.stringify(h.app.ctx.db.prepare('SELECT * FROM api_calls').all());
    for (const t of tokens) expect(dump).not.toContain(t);
    expect(dump).not.toContain(S2S_CLIENT.clientSecret);
    expect(dump).not.toContain(USER_CLIENT.clientSecret);
  });
});
