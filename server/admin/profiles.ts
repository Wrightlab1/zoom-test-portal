import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam } from './util.js';

const secretField = z.string().max(4096).nullable().optional();

const profileInput = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,48}$/, 'lowercase letters, digits and dashes only')
    .optional(),
  type: z.enum(['s2s', 'user']),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: secretField,
  accountId: z.string().trim().max(200).nullable().optional(),
  webhookSecret: secretField,
  usePkce: z.boolean().optional(),
  acceptMarketplaceInstalls: z.boolean().optional(),
  autoRefresh: z.boolean().optional(),
  scopesRequested: z.string().max(4000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

export function registerProfileRoutes(app: FastifyInstance, ctx: Ctx) {
  const s = ctx.services;

  const full = (id: number) => {
    const p = s.profiles.get(id);
    if (!p) throw new HttpError(404, 'not_found', 'Profile not found');
    return {
      ...s.profiles.view(p),
      urls: s.publicUrls.forProfile(p.slug),
      authorizations: s.auths.listForProfile(p.id).map((a) => s.auths.view(a)),
    };
  };

  app.get('/api/profiles', async () =>
    s.profiles.list().map((p) => ({
      ...s.profiles.view(p),
      urls: s.publicUrls.forProfile(p.slug),
      authorizations: s.auths.listForProfile(p.id, false).map((a) => s.auths.view(a)),
    })),
  );

  app.get('/api/profiles/:id', async (req) => full(idParam.parse(req.params).id));

  app.post('/api/profiles', async (req, reply) => {
    const body = profileInput.parse(req.body);
    if (body.type === 's2s' && !body.accountId) throw new HttpError(400, 'invalid', 'Server-to-Server profiles need an Account ID');
    const p = s.profiles.create(body);
    reply.code(201);
    return full(p.id);
  });

  app.put('/api/profiles/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = profileInput.partial().parse(req.body);
    // Secret fields are write-only: omitted or undefined means "keep"; empty string or null clears.
    const p = s.profiles.update(id, body);
    if (!p) throw new HttpError(404, 'not_found', 'Profile not found');
    return full(id);
  });

  app.post('/api/profiles/:id/duplicate', async (req, reply) => {
    const p = s.profiles.duplicate(idParam.parse(req.params).id);
    if (!p) throw new HttpError(404, 'not_found', 'Profile not found');
    reply.code(201);
    return full(p.id);
  });

  app.delete('/api/profiles/:id', async (req) => {
    if (!s.profiles.delete(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found', 'Profile not found');
    return { ok: true };
  });

  app.get('/api/profiles/:id/token-events', async (req) => {
    const { id } = idParam.parse(req.params);
    return s.auths.events(id, 100);
  });

  // S2S: get (or force a new) token.
  app.post('/api/profiles/:id/s2s-token', async (req) => {
    const { id } = idParam.parse(req.params);
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const { row } = await s.tokens.s2sToken(id, { force: force ?? true });
    return s.auths.view(row);
  });

  // ---- admin (bulk) authorizations: code_type=bulk ----
  app.get('/api/profiles/:id/bulk-grants', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!s.profiles.get(id)) throw new HttpError(404, 'not_found', 'Profile not found');
    return s.bulkGrants.listForProfile(id).map((g) => s.bulkGrants.view(g));
  });

  /** Retrieve user tokens now: continues a waiting/failed grant, or re-runs a finished one. */
  app.post('/api/bulk-grants/:id/fetch', async (req) => {
    const g = await s.bulk.run(idParam.parse(req.params).id, { manual: true });
    return s.bulkGrants.view(g);
  });

  /** Forget the grant and its bulk token. User authorizations it produced are kept. */
  app.delete('/api/bulk-grants/:id', async (req) => {
    if (!s.bulk.delete(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  // ---- authorizations ----
  app.get('/api/authorizations/:id', async (req) => {
    const row = s.auths.get(idParam.parse(req.params).id);
    if (!row) throw new HttpError(404, 'not_found');
    return s.auths.view(row);
  });

  app.post('/api/authorizations/:id/refresh', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = s.auths.get(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.kind === 's2s') return s.auths.view((await s.tokens.s2sToken(row.profile_id, { force: true })).row);
    return s.auths.view(await s.tokens.refreshUser(id, { force: true, reason: 'manual' }));
  });

  app.post('/api/authorizations/:id/revoke', async (req) => s.auths.view(await s.tokens.revoke(idParam.parse(req.params).id)));

  /** Deliberate reveal of a raw token. The only admin route that returns a token value. */
  app.post('/api/authorizations/:id/reveal', async (req) => {
    const { id } = idParam.parse(req.params);
    const { field } = z.object({ field: z.enum(['access_token', 'refresh_token']) }).parse(req.body);
    const value = s.tokens.reveal(id, field);
    if (!value) throw new HttpError(404, 'no_value', 'No such token stored');
    req.log.info({ authorizationId: id, field }, 'token revealed');
    return { field, value };
  });

  app.delete('/api/authorizations/:id', async (req) => {
    if (!s.auths.delete(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });
}
