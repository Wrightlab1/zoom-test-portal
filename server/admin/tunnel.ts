import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam } from './util.js';

export function registerTunnelRoutes(app: FastifyInstance, ctx: Ctx) {
  const s = ctx.services;
  app.get('/api/tunnel', async () => s.tunnel.status());
  app.post('/api/tunnel/start', async () => {
    try {
      await s.tunnel.start();
    } catch (e) {
      throw new HttpError(502, 'tunnel_error', (e as Error).message);
    }
    return s.tunnel.status();
  });
  app.post('/api/tunnel/stop', async () => {
    await s.tunnel.stop();
    return s.tunnel.status();
  });
  /** "I've updated the Marketplace" — clears the URL-changed warning. */
  app.post('/api/tunnel/acknowledge', async () => {
    s.tunnel.acknowledge();
    return s.tunnel.status();
  });
  app.get('/api/tunnel/marketplace-fields', async () => s.tunnel.marketplaceFields());

  app.post('/api/profiles/:id/authorize', async (req) => {
    const { id } = idParam.parse(req.params);
    const { scope } = z.object({ scope: z.string().max(4000).optional() }).parse(req.body ?? {});
    return s.userOAuth.start(id, { scope });
  });

  app.post('/api/authorizations/:id/relabel', async (req) => {
    const { id } = idParam.parse(req.params);
    const { row, accessToken } = await s.tokens.accessTokenFor(id);
    const me = await s.userOAuth.relabel(row, accessToken);
    return { ...s.auths.view(s.auths.get(id)!), lookupError: me.error };
  });
}
