import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv, isLoopbackHost, type AppConfig } from './config.js';
import { Cipher, loadMasterKey, randomToken, type LoadedKey } from './lib/crypto.js';
import { dbExists, migrate, openDb, verifyOrInitKey } from './db/index.js';
import { SettingsRepo } from './db/settings.js';
import { AdminRepo } from './db/sessions.js';
import { Bus, type Ctx } from './context.js';
import { loggerOptions } from './lib/logger.js';
import { registerAuth } from './admin/auth.js';
import { registerAdminRoutes } from './admin/routes.js';
import { buildPublicServer } from './public/server.js';
import { createServices } from './services/index.js';

export interface App {
  ctx: Ctx;
  admin: FastifyInstance;
  pub: FastifyInstance;
  key: LoadedKey;
  start(): Promise<{ adminUrl: string; publicUrl: string }>;
  stop(): Promise<void>;
}

export class StartupError extends Error {}

const here = path.dirname(fileURLToPath(import.meta.url));

function findWebDist(): string | null {
  for (const p of [path.resolve(here, '../web'), path.resolve(here, '../dist/web'), path.resolve(process.cwd(), 'dist/web')]) {
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}

export async function createApp(overrides: Partial<AppConfig> = {}): Promise<App> {
  const cfg: AppConfig = { ...configFromEnv(), ...overrides };

  if (!isLoopbackHost(cfg.adminHost) && !cfg.adminAllowNonLoopback) {
    throw new StartupError(
      `ZTP_ADMIN_HOST=${cfg.adminHost} is not a loopback address. The admin UI holds live Zoom credentials;\n` +
        'binding it to another interface exposes it to your network. If you really want this, also set\n' +
        'ZTP_ADMIN_ALLOW_NON_LOOPBACK=1 (and consider ZTP_ADMIN_ALLOWED_HOSTS).',
    );
  }

  const firstRun = !dbExists(cfg.dbFile);
  const key = loadMasterKey({ envKey: cfg.masterKeyEnv, keyFile: cfg.keyFile, firstRun });
  const cipher = new Cipher(key.key);
  const db = openDb(cfg.dbFile);
  migrate(db);
  verifyOrInitKey(db, cipher);

  const settings = new SettingsRepo(db, cipher);
  const adminRepo = new AdminRepo(db);
  const ctx: Ctx = {
    cfg,
    db,
    cipher,
    settings,
    adminRepo,
    bus: new Bus(),
    setupCode: adminRepo.hasPassword() ? null : randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase(),
    services: undefined as never,
  };
  ctx.services = createServices(ctx);

  // ---- admin listener -------------------------------------------------------------
  const admin = Fastify({ logger: loggerOptions(cfg.logLevel, 'admin'), bodyLimit: 64 * 1024 * 1024, trustProxy: false });
  await admin.register(cookie);
  registerAuth(admin, ctx);
  registerAdminRoutes(admin, ctx);

  const webDist = findWebDist();
  if (webDist) {
    await admin.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, index: ['index.html'] });
    admin.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    admin.get('/', async (_req, reply) =>
      reply.type('text/plain').send('UI not built. In development open the Vite dev server (npm run dev); otherwise run npm run build.'),
    );
  }

  // ---- public listener (tunnel target) -----------------------------------------------
  const pub = buildPublicServer(ctx);

  let started = false;
  return {
    ctx,
    admin,
    pub,
    key,
    async start() {
      const adminAddr = await admin.listen({ host: cfg.adminHost, port: cfg.adminPort });
      const publicAddr = await pub.listen({ host: cfg.publicHost, port: cfg.publicPort });
      started = true;
      await ctx.services.startBackground();
      return { adminUrl: adminAddr, publicUrl: publicAddr };
    },
    async stop() {
      await ctx.services.stopBackground();
      if (started) {
        await pub.close();
        await admin.close();
      }
      db.close();
    },
  };
}
