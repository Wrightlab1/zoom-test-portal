import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../server/app.js';
import { DEFAULT_ALLOWLIST } from '../server/db/settings.js';
import { createMockZoom, type MockClient } from '../mock-zoom/mock.js';

export function tmpDir(prefix = 'ztp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export class AdminClient {
  cookie = '';
  csrf = '';
  constructor(readonly base: string) {}

  async req<T = any>(method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = /ztp_sid=([^;]*)/.exec(sc);
      if (m) this.cookie = m[1] ? `ztp_sid=${m[1]}` : '';
    }
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.csrf === 'string') this.csrf = parsed.csrf;
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p);
  }
  post<T = any>(p: string, body: unknown = {}) {
    return this.req<T>('POST', p, body);
  }
  put<T = any>(p: string, body: unknown) {
    return this.req<T>('PUT', p, body);
  }
  del<T = any>(p: string) {
    return this.req<T>('DELETE', p);
  }
}

export const S2S_CLIENT: MockClient = {
  clientId: 'test-s2s-client',
  clientSecret: 'test-s2s-secret-value-0001',
  accountId: 'mockaccount1',
  redirectUris: [],
};
export const USER_CLIENT: MockClient = {
  clientId: 'test-user-client',
  clientSecret: 'test-user-secret-value-0002',
  redirectUris: [],
};
export const WEBHOOK_SECRET = 'test-webhook-secret-token-0003';

export interface Harness {
  app: App;
  admin: AdminClient;
  adminUrl: string;
  publicUrl: string;
  mock: ReturnType<typeof createMockZoom>;
  mockUrl: string;
  dir: string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const mock = createMockZoom({ clients: [S2S_CLIENT, USER_CLIENT] });
  const mockUrl = await mock.listen(0);
  const dir = tmpDir();
  const app = await createApp({
    dataDir: dir,
    dbFile: path.join(dir, 'portal.db'),
    keyFile: path.join(dir, 'key', 'master.key'),
    masterKeyEnv: undefined,
    adminHost: '127.0.0.1',
    adminPort: 0,
    publicHost: '127.0.0.1',
    publicPort: 0,
    logLevel: 'silent',
    disableSchedulers: true,
  });
  const { adminUrl, publicUrl } = await app.start();
  app.ctx.settings.update({
    allowlist: [...DEFAULT_ALLOWLIST, mockUrl],
    oauthBaseUrl: mockUrl,
    apiBaseUrl: mockUrl,
    publicBaseUrlOverride: publicUrl,
  });
  const admin = new AdminClient(adminUrl);
  const r = await admin.post('/api/auth/setup', { password: 'correct horse battery staple', setupCode: app.ctx.setupCode });
  if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
  return {
    app,
    admin,
    adminUrl,
    publicUrl,
    mock,
    mockUrl,
    dir,
    async close() {
      await app.stop();
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
