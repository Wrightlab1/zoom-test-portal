import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { installErrorHandler } from './util.js';
import { registerProfileRoutes } from './profiles.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTunnelRoutes } from './tunnel.js';
import { registerStreamRoutes } from './stream.js';

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  installErrorHandler(app);
  app.get('/api/health', async () => ({ ok: true, keyFingerprint: ctx.cipher.fingerprint }));
  registerProfileRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerTunnelRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
}
