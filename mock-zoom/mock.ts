/**
 * Mock Zoom OAuth + REST server for tests and local development. NOT a faithful Zoom clone:
 * it implements the behaviours the portal must handle (grant types, refresh token rotation,
 * PKCE, exact redirect URI match, re-authorization invalidating old tokens, expiry, pagination,
 * 429s, double-encoded UUIDs, redirects) with Zoom-shaped responses.
 *
 * All credentials here are fake test values.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export interface MockClient {
  clientId: string;
  clientSecret: string;
  accountId?: string;
  redirectUris: string[];
}

interface UserRec {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  account_id: string;
  type: number;
}
interface CodeRec {
  clientId: string;
  redirectUri: string;
  userId: string;
  challenge?: string;
  method?: string;
  exp: number;
  used: boolean;
  scope: string;
}
interface AccessRec {
  clientId: string;
  userId: string | null;
  exp: number;
  scope: string;
  family: string;
}
interface RefreshRec {
  clientId: string;
  userId: string;
  family: string;
  scope: string;
}

export interface MockConfig {
  tokenTtlSec: number;
  refreshDelayMs: number;
  currentUser: string;
  /** Respond to the next N token requests with this error. */
  failNextToken: { count: number; status: number; body: Record<string, unknown> } | null;
}

export interface MockStats {
  tokenRequests: Record<string, number>;
  apiRequests: number;
  revokes: number;
}

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

export const MEETING_UUID = '/abc+def//ghi==';

export function createMockZoom(opts: { clients?: MockClient[] } = {}) {
  const clients = new Map<string, MockClient>();
  for (const c of opts.clients ?? []) clients.set(c.clientId, c);
  const users = new Map<string, UserRec>();
  const mkUser = (i: number, first: string, last: string): UserRec => ({
    id: `mockuser${String(i).padStart(3, '0')}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.test`,
    first_name: first,
    last_name: last,
    account_id: 'mockaccount1',
    type: 2,
  });
  users.set('mockuser001', mkUser(1, 'Alice', 'Admin'));
  users.set('mockuser002', mkUser(2, 'Bob', 'Builder'));
  for (let i = 3; i <= 57; i++) users.set(`mockuser${String(i).padStart(3, '0')}`, mkUser(i, `User${i}`, 'Test'));

  const codes = new Map<string, CodeRec>();
  const access = new Map<string, AccessRec>();
  const refresh = new Map<string, RefreshRec>();
  const pageTokens = new Map<string, number>();
  const config: MockConfig = { tokenTtlSec: 3600, refreshDelayMs: 0, currentUser: 'mockuser001', failNextToken: null };
  const stats: MockStats = { tokenRequests: {}, apiRequests: 0, revokes: 0 };
  let baseUrl = '';

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json;charset=UTF-8',
      'x-zm-trackingid': `v=2.0;clid=mock;rid=WEB_${crypto.randomBytes(16).toString('hex')}`,
      ...headers,
    });
    res.end(text);
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const basicClient = (req: http.IncomingMessage): MockClient | null => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const [id, secret] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const c = clients.get(id);
    return c && c.clientSecret === secret ? c : null;
  };

  const issue = (clientId: string, userId: string | null, scope: string, withRefresh: boolean, family = rand(8)) => {
    const at = 'mock_at_' + rand(32);
    access.set(at, { clientId, userId, exp: Date.now() + config.tokenTtlSec * 1000, scope, family });
    const out: Record<string, unknown> = { access_token: at, token_type: 'bearer', expires_in: config.tokenTtlSec, scope, api_url: baseUrl };
    if (withRefresh && userId) {
      const rt = 'mock_rt_' + rand(32);
      refresh.set(rt, { clientId, userId, family, scope });
      out.refresh_token = rt;
    }
    return out;
  };

  /** Re-authorizing the same user for the same app invalidates the previous tokens (Zoom 4741 behaviour). */
  const invalidateUser = (clientId: string, userId: string) => {
    for (const [k, v] of access) if (v.clientId === clientId && v.userId === userId) access.delete(k);
    for (const [k, v] of refresh) if (v.clientId === clientId && v.userId === userId) refresh.delete(k);
  };

  const rateHeaders = (category = 'Light', remaining = 79) => ({
    'x-ratelimit-category': category,
    'x-ratelimit-type': 'QPS',
    'x-ratelimit-limit': '80',
    'x-ratelimit-remaining': String(remaining),
  });

  async function handleToken(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const body = (await readBody(req)).toString('utf8');
    const p = new URLSearchParams(body);
    for (const [k, v] of url.searchParams) if (!p.has(k)) p.set(k, v); // Zoom also accepts query params
    const grant = p.get('grant_type') ?? '';
    stats.tokenRequests[grant] = (stats.tokenRequests[grant] ?? 0) + 1;

    if (config.failNextToken && config.failNextToken.count > 0) {
      config.failNextToken.count--;
      return send(res, config.failNextToken.status, config.failNextToken.body);
    }
    const client = basicClient(req);
    if (!client) return send(res, 401, { reason: 'Invalid client_id or client_secret', error: 'invalid_client' });

    switch (grant) {
      case 'account_credentials': {
        if (!client.accountId || p.get('account_id') !== client.accountId) {
          return send(res, 400, { reason: 'Invalid account_id', error: 'invalid_request' });
        }
        return send(res, 200, issue(client.clientId, null, 'user:read:admin meeting:read:admin', false));
      }
      case 'client_credentials':
        return send(res, 200, issue(client.clientId, null, 'imchat:bot', false));
      case 'authorization_code': {
        const code = codes.get(p.get('code') ?? '');
        if (!code || code.clientId !== client.clientId) return send(res, 400, { reason: 'Invalid authorization code', error: 'invalid_request' });
        if (code.used) return send(res, 400, { reason: 'Invalid authorization code', error: 'invalid_request' });
        if (code.exp < Date.now()) return send(res, 400, { reason: 'Authorization code is expired', error: 'invalid_request' });
        if (p.get('redirect_uri') !== code.redirectUri) return send(res, 400, { reason: 'Redirect URI mismatch.', error: 'invalid_request' });
        if (code.challenge) {
          const v = p.get('code_verifier') ?? '';
          const calc = code.method === 'S256' ? crypto.createHash('sha256').update(v).digest('base64url') : v;
          if (calc !== code.challenge) return send(res, 400, { reason: 'Invalid code_verifier', error: 'invalid_request' });
        }
        code.used = true;
        invalidateUser(client.clientId, code.userId);
        return send(res, 200, issue(client.clientId, code.userId, code.scope, true));
      }
      case 'refresh_token': {
        const rt = p.get('refresh_token') ?? '';
        const rec = refresh.get(rt);
        if (config.refreshDelayMs) await new Promise((r) => setTimeout(r, config.refreshDelayMs));
        if (!rec || rec.clientId !== client.clientId) return send(res, 400, { reason: 'Invalid Token!', error: 'invalid_request' });
        refresh.delete(rt); // rotation: the old refresh token stops working immediately
        return send(res, 200, issue(client.clientId, rec.userId, rec.scope, true, rec.family));
      }
      default:
        return send(res, 400, { reason: 'Unsupported grant type', error: 'unsupported_grant_type' });
    }
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, rawPath: string) {
    stats.apiRequests++;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const tok = m ? access.get(m[1]) : undefined;
    if (!tok) return send(res, 401, { code: 124, message: 'Invalid access token.' }, rateHeaders());
    if (tok.exp < Date.now()) return send(res, 401, { code: 124, message: 'Access token is expired.' }, rateHeaders());
    const me = tok.userId ? users.get(tok.userId)! : users.get('mockuser001')!;
    const path = url.pathname;

    if (req.method === 'GET' && path === '/v2/users/me') {
      return send(res, 200, { ...me, display_name: `${me.first_name} ${me.last_name}`, status: 'active', role_name: 'Owner' }, rateHeaders());
    }
    if (req.method === 'GET' && path === '/v2/users') {
      const size = Math.min(300, Math.max(1, Number(url.searchParams.get('page_size') ?? 30)));
      const npt = url.searchParams.get('next_page_token');
      let start = 0;
      if (npt) {
        const s = pageTokens.get(npt);
        if (s === undefined) return send(res, 400, { code: 300, message: 'Invalid next_page_token.' }, rateHeaders());
        start = s;
      }
      const all = [...users.values()];
      const page = all.slice(start, start + size);
      let next = '';
      if (start + size < all.length) {
        next = rand(12);
        pageTokens.set(next, start + size);
      }
      return send(res, 200, { page_size: size, total_records: all.length, next_page_token: next, users: page }, rateHeaders('Medium', 55));
    }
    if (req.method === 'POST' && path === '/v2/users/me/meetings') {
      const body = (await readBody(req)).toString('utf8');
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(body || '{}');
      } catch {
        return send(res, 400, { code: 300, message: 'Request Body should be a valid JSON object.' }, rateHeaders());
      }
      return send(res, 201, { id: 99990707175, uuid: MEETING_UUID, host_id: me.id, topic: j.topic ?? 'Mock meeting', type: j.type ?? 2 }, rateHeaders('Medium', 54));
    }
    // UUID must arrive double-encoded: one decode of the raw segment must not produce a '/'.
    const pm = /^\/v2\/past_meetings\/([^/]+)$/.exec(rawPath);
    if (req.method === 'GET' && pm) {
      const once = decodeURIComponent(pm[1]);
      if (once.includes('/') || decodeURIComponent(once) !== MEETING_UUID) {
        return send(res, 404, { code: 3001, message: 'Meeting does not exist: ' + once }, rateHeaders());
      }
      return send(res, 200, { uuid: MEETING_UUID, id: 99990707175, topic: 'Past mock meeting' }, rateHeaders());
    }
    if (req.method === 'GET' && path === '/v2/ratelimit-test') {
      return send(res, 429, { code: 429, message: "You have reached the maximum per-second rate limit for this API. Try again later." }, {
        ...rateHeaders('Heavy', 0),
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        'retry-after': new Date(Date.now() + 1000).toISOString(),
      });
    }
    if (req.method === 'GET' && path === '/v2/recordings/download') {
      return send(res, 302, undefined, { location: '/rec/file/mock.bin' });
    }
    return send(res, 404, { code: 404, message: 'Not Found' }, rateHeaders());
  }

  const server = http.createServer(async (req, res) => {
    const rawPath = (req.url ?? '/').split('?')[0];
    const url = new URL(req.url ?? '/', 'http://mock');
    try {
      // ---- control plane for tests ----
      if (url.pathname.startsWith('/__mock/')) {
        const body = (await readBody(req)).toString('utf8');
        const j = body ? JSON.parse(body) : {};
        switch (url.pathname) {
          case '/__mock/clients':
            clients.set(j.clientId, j);
            return send(res, 200, { ok: true });
          case '/__mock/config':
            Object.assign(config, j);
            return send(res, 200, config);
          case '/__mock/expire':
            for (const v of access.values()) v.exp = Date.now() - 1000;
            return send(res, 200, { expired: access.size });
          case '/__mock/stats':
            return send(res, 200, stats);
          default:
            return send(res, 404, { error: 'unknown mock control' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const c = clients.get(url.searchParams.get('client_id') ?? '');
        if (!c) return send(res, 400, '<h1>Invalid client_id</h1>');
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        if (!c.redirectUris.includes(redirectUri)) return send(res, 400, '<h1>Invalid redirect: 4,700</h1><p>Redirect URI mismatch.</p>');
        const code = 'mock_code_' + rand(16);
        codes.set(code, {
          clientId: c.clientId,
          redirectUri,
          userId: url.searchParams.get('mock_user') ?? config.currentUser,
          challenge: url.searchParams.get('code_challenge') ?? undefined,
          method: url.searchParams.get('code_challenge_method') ?? (url.searchParams.get('code_challenge') ? 'plain' : undefined),
          exp: Date.now() + 5 * 60_000,
          used: false,
          scope: 'user:read:user meeting:read:list_meetings meeting:write:meeting',
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        const state = url.searchParams.get('state');
        if (state) target.searchParams.set('state', state);
        return send(res, 302, undefined, { location: target.toString() });
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') return await handleToken(req, res, url);
      if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
        const c = basicClient(req);
        if (!c) return send(res, 401, { reason: 'Invalid client_id or client_secret', error: 'invalid_client' });
        const p = new URLSearchParams((await readBody(req)).toString('utf8'));
        for (const [k, v] of url.searchParams) if (!p.has(k)) p.set(k, v);
        const t = p.get('token') ?? '';
        const fam = access.get(t)?.family ?? refresh.get(t)?.family;
        if (!fam) return send(res, 400, { reason: 'Invalid Token!', error: 'invalid_request' });
        for (const [k, v] of access) if (v.family === fam) access.delete(k);
        for (const [k, v] of refresh) if (v.family === fam) refresh.delete(k);
        stats.revokes++;
        return send(res, 200, { status: 'success' });
      }
      if (url.pathname === '/rec/file/mock.bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(crypto.randomBytes(2048));
      }
      if (url.pathname.startsWith('/v2/')) return await handleApi(req, res, url, rawPath);
      return send(res, 404, { code: 404, message: 'Not Found' });
    } catch (e) {
      return send(res, 500, { code: 500, message: (e as Error).message });
    }
  });

  return {
    server,
    config,
    stats,
    clients,
    access,
    refresh,
    expireAll() {
      for (const v of access.values()) v.exp = Date.now() - 1000;
    },
    async listen(port = 0, host = '127.0.0.1'): Promise<string> {
      await new Promise<void>((r) => server.listen(port, host, () => r()));
      const addr = server.address() as { port: number };
      baseUrl = `http://${host}:${addr.port}`;
      return baseUrl;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
