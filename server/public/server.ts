import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { loggerOptions } from '../lib/logger.js';
import { callbackPage } from './pages.js';

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

  // OAuth redirect target. The query carries `code` and `state`; neither is logged.
  pub.get<{ Params: { slug: string }; Querystring: Record<string, string> }>('/oauth/callback/:slug', async (req, reply) => {
    const out = await ctx.services.userOAuth.callback(req.params.slug, req.query ?? {});
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return reply.code(out.status).type('text/html; charset=utf-8').send(callbackPage(out.title, out.message, out.ok));
  });

  // Webhook receiver. Encapsulated so the raw-body parser applies only here: the HMAC must be
  // computed over the exact bytes Zoom sent, so bodies are never JSON-parsed before verification.
  pub.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.url.split('?')[0];
      const m = /^\/webhooks\/zoom\/([a-z0-9-]{1,48})$/.exec(path);
      const { response } = ctx.services.webhooks.handle({
        method: req.method,
        path,
        slug: m ? m[1] : null,
        headers: req.headers,
        raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        remoteIp: req.ip,
      });
      return reply.code(response.status).type(response.contentType).send(response.body);
    };
    inst.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], url: '/webhooks/*', handler });
  });

  pub.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not Found'));
  pub.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const sc = err.statusCode ?? 500;
    const code = sc >= 400 && sc < 500 ? sc : 500;
    reply.code(code).type('text/plain').send(code === 500 ? 'Internal Server Error' : 'Bad Request');
  });

  return pub;
}
