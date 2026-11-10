import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/health', async () => ({ ok: true, keyFingerprint: ctx.cipher.fingerprint }));
}
