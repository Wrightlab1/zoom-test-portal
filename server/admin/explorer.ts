import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { HttpError, idParam } from './util.js';
import { parseCollection, parseEnvironment, PostmanError } from '../lib/postman.js';
import { sendInput } from '../services/explorer.js';
import { callView } from './views.js';

export function registerExplorerRoutes(app: FastifyInstance, ctx: Ctx) {
  const s = ctx.services;

  // ---- collections ----
  app.get('/api/collections', async () =>
    s.collections.list().map((c) => ({ id: c.id, name: c.name, postmanId: c.postman_id, description: c.description, requestCount: c.request_count, importedAt: c.imported_at, updatedAt: c.updated_at, variables: s.collections.variables(c).map((v) => ({ key: v.key, value: v.value })) })),
  );

  app.post('/api/collections/import', async (req) => {
    const body = z.object({ collection: z.unknown(), targetId: z.number().int().positive().optional() }).parse(req.body);
    let parsed;
    try {
      parsed = parseCollection(body.collection);
    } catch (e) {
      if (e instanceof PostmanError) throw new HttpError(400, 'invalid_collection', e.message);
      throw e;
    }
    return s.collections.import(parsed, { targetId: body.targetId, sourceText: JSON.stringify(body.collection) });
  });

  app.get('/api/collections/:id/tree', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!s.collections.get(id)) throw new HttpError(404, 'not_found');
    return s.collections.tree(id);
  });

  app.delete('/api/collections/:id', async (req) => {
    if (!s.collections.delete(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  app.get('/api/collection-requests/:id', async (req) => {
    const r = s.collections.getRequest(idParam.parse(req.params).id);
    if (!r) throw new HttpError(404, 'not_found');
    return {
      id: r.id,
      collectionId: r.collection_id,
      folderId: r.folder_id,
      name: r.name,
      method: r.method,
      matchKey: r.match_key,
      urlRaw: r.url_raw,
      pathTemplate: r.path_template,
      description: r.description,
      definition: r.definition,
      updatedAt: r.updated_at,
    };
  });

  // ---- environments ----
  const envView = (id: number) => {
    const env = s.collections.listEnvironments().find((e) => e.id === id);
    if (!env) throw new HttpError(404, 'not_found');
    const values = (s.collections.environmentValues(id) ?? []).map((v) => ({ ...v, value: v.type === 'secret' ? '' : v.value, hasValue: !!v.value }));
    return { ...env, values };
  };
  app.get('/api/environments', async () => s.collections.listEnvironments().map((e) => envView(e.id)));
  app.post('/api/environments/import', async (req) => {
    const body = z.object({ environment: z.unknown() }).parse(req.body);
    try {
      const r = s.collections.importEnvironment(parseEnvironment(body.environment));
      return { ...r, environment: envView(r.id) };
    } catch (e) {
      if (e instanceof PostmanError) throw new HttpError(400, 'invalid_environment', e.message);
      throw e;
    }
  });
  app.put('/api/environments/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { values } = z.object({ values: z.array(z.object({ key: z.string(), value: z.string().optional(), disabled: z.boolean().optional(), type: z.string().optional() })) }).parse(req.body);
    const prev = new Map((s.collections.environmentValues(id) ?? []).map((v) => [v.key, v]));
    // Secret values are write-only: an omitted value keeps the stored one.
    const merged = values.map((v) => ({ key: v.key, value: v.value ?? prev.get(v.key)?.value ?? '', ...(v.disabled ? { disabled: true } : {}), ...(v.type ? { type: v.type } : {}) }));
    if (!s.collections.updateEnvironmentValues(id, merged)) throw new HttpError(404, 'not_found');
    return envView(id);
  });
  app.delete('/api/environments/:id', async (req) => {
    if (!s.collections.deleteEnvironment(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  // ---- saved requests ----
  const savedBody = z.object({
    name: z.string().trim().min(1).max(200),
    collectionRequestId: z.number().int().positive().nullable().optional(),
    profileId: z.number().int().positive().nullable().optional(),
    authorizationId: z.number().int().positive().nullable().optional(),
    request: z.record(z.string(), z.unknown()),
  });
  app.get('/api/saved-requests', async () => s.collections.listSaved());
  app.post('/api/saved-requests', async (req, reply) => {
    const b = savedBody.parse(req.body);
    reply.code(201);
    return s.collections.getSaved(s.collections.saveRequest(b));
  });
  app.put('/api/saved-requests/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!s.collections.getSaved(id)) throw new HttpError(404, 'not_found');
    return s.collections.getSaved(s.collections.saveRequest({ ...savedBody.parse(req.body), id }));
  });
  app.delete('/api/saved-requests/:id', async (req) => {
    if (!s.collections.deleteSaved(idParam.parse(req.params).id)) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  // ---- send / replay / curl ----
  app.post('/api/send', async (req) => {
    const input = sendInput.parse(req.body);
    const r = await s.explorer.send(input);
    return { calls: r.calls.map(callView), warnings: r.warnings };
  });
  app.post('/api/send/preview', async (req) => {
    const input = sendInput.parse(req.body);
    const p = await s.explorer.prepare(input, { withToken: false });
    return { method: p.method, url: p.url, endpoint: p.endpoint, warnings: p.warnings };
  });
  app.post('/api/send/curl', async (req) => {
    const { reveal, ...rest } = z.object({ reveal: z.boolean().default(false) }).passthrough().parse(req.body);
    return s.explorer.curlForInput(sendInput.parse(rest), reveal);
  });
  app.post('/api/calls/:id/replay', async (req) => {
    const r = await s.explorer.replay(idParam.parse(req.params).id);
    return { calls: r.calls.map(callView), warnings: r.warnings };
  });
  app.get('/api/calls/:id/curl', async (req) => {
    const { id } = idParam.parse(req.params);
    const { reveal } = z.object({ reveal: z.enum(['0', '1']).optional() }).parse(req.query);
    return { curl: s.explorer.curlForCall(id, reveal === '1') };
  });
  app.get('/api/calls/:id/input', async (req) => {
    const row = s.calls.get(idParam.parse(req.params).id);
    if (!row) throw new HttpError(404, 'not_found');
    return s.explorer.inputFromCall(row);
  });
}
