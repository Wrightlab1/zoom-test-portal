import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { loggerOptions } from '../lib/logger.js';

/**
 * The only listener the tunnel points at. It serves exactly two route families:
 *   GET  /oauth/callback/:slug   — OAuth redirect target
 *   ANY  /webhooks/zoom/:slug    — Zoom event subscription endpoint
 * Everything else is a bare 404 with no body detail.
 */
export function buildPublicServer(ctx: Ctx): FastifyInstance {
  const pub = Fastify({
    logger: loggerOptions(ctx.cfg.logLevel, 'public'),
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true, // ngrok sets X-Forwarded-For; used for logging only
    exposeHeadRoutes: false,
  });

  pub.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  pub.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not Found'));
  pub.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const sc = err.statusCode ?? 500;
    const code = sc >= 400 && sc < 500 ? sc : 500;
    reply.code(code).type('text/plain').send(code === 500 ? 'Internal Server Error' : 'Bad Request');
  });

  return pub;
}
