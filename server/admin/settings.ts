import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { validateAllowlist } from '../lib/allowlist.js';
import { DEFAULT_ALLOWLIST } from '../db/settings.js';
import { HttpError } from './util.js';
import { mask } from '../lib/redact.js';
import { isLoopbackHost } from '../config.js';

const urlField = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

const settingsPatch = z.object({
  allowlist: z.array(z.string().trim().min(1)).max(200).optional(),
  oauthBaseUrl: urlField.optional(),
  apiBaseUrl: urlField.optional(),
  webhookToleranceSec: z.number().int().min(0).max(86400).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  maxStoredBodyBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
  refreshLeadSec: z.number().int().min(30).max(3000).optional(),
  ngrokDomain: z.string().trim().max(253).regex(/^[a-z0-9.-]*$/i, 'hostname only, no scheme').optional(),
  ngrokAutostart: z.boolean().optional(),
  publicBaseUrlOverride: z.union([z.literal(''), urlField]).optional(),
  ngrokAuthtoken: z.string().trim().max(500).nullable().optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: Ctx) {
  const view = () => {
    const s = ctx.settings.get();
    const at = ctx.settings.getSecret('ngrokAuthtoken');
    return {
      ...s,
      defaultAllowlist: DEFAULT_ALLOWLIST,
      ngrokAuthtokenHint: at ? mask(at) : null,
      admin: { host: ctx.cfg.adminHost, port: ctx.cfg.adminPort, loopback: isLoopbackHost(ctx.cfg.adminHost) },
      publicListener: { host: ctx.cfg.publicHost, port: ctx.cfg.publicPort },
      dataDir: ctx.cfg.dataDir,
      keyFingerprint: ctx.cipher.fingerprint,
    };
  };

  app.get('/api/settings', async () => view());

  app.put('/api/settings', async (req) => {
    const { ngrokAuthtoken, ...patch } = settingsPatch.parse(req.body);
    if (patch.allowlist) {
      try {
        patch.allowlist = validateAllowlist(patch.allowlist);
      } catch (e) {
        throw new HttpError(400, 'invalid', (e as Error).message);
      }
    }
    // The OAuth host receives the client secret; it must itself be allowlisted.
    const allow = patch.allowlist ?? ctx.settings.get().allowlist;
    const { isAllowed } = await import('../lib/allowlist.js');
    for (const k of ['oauthBaseUrl', 'apiBaseUrl'] as const) {
      const v = patch[k] ?? ctx.settings.get()[k];
      if (!isAllowed(v, allow)) throw new HttpError(400, 'invalid', `${k} (${v}) is not covered by the allowlist`);
    }
    ctx.settings.update(patch);
    if (ngrokAuthtoken !== undefined) {
      ctx.settings.setSecret('ngrokAuthtoken', ngrokAuthtoken || null);
      const { secrets } = await import('../lib/redact.js');
      secrets.add(ngrokAuthtoken);
    }
    return view();
  });
}
