import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { z } from 'zod';
import { randomToken, safeEqual, sha256hex } from '../lib/crypto.js';
import { isLoopbackHost } from '../config.js';
import type { Ctx } from '../context.js';

export const SESSION_COOKIE = 'ztp_sid';
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const SESSION_IDLE_MS = 12 * 3600_000;

// argon2id, OWASP-recommended parameters (19 MiB, t=2, p=1).
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => argonHash(pw, ARGON_OPTS);
export const verifyPassword = (h: string, pw: string) => argonVerify(h, pw);

declare module 'fastify' {
  interface FastifyRequest {
    session?: { idHash: string; csrf: string };
  }
}

/** Requests that may be made without a session. */
const PUBLIC_API = new Set(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/setup']);

function hostAllowed(ctx: Ctx, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHost(hostname) || ctx.cfg.adminAllowedHosts.includes(hostname) || ctx.cfg.adminAllowedHosts.includes(hostHeader.toLowerCase());
}

function originAllowed(ctx: Ctx, origin: string | undefined): boolean {
  if (!origin) return true; // same-origin fetches from older browsers may omit it; CSRF token still required
  try {
    const u = new URL(origin);
    return hostAllowed(ctx, u.host);
  } catch {
    return false;
  }
}

/** Simple progressive lockout for login attempts. */
const failures = { count: 0, lockedUntil: 0 };

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  // 1) DNS-rebinding guard: only answer to expected Host names.
  app.addHook('onRequest', async (req, reply) => {
    if (!hostAllowed(ctx, req.headers.host)) {
      return reply.code(421).type('text/plain').send('Misdirected request: unexpected Host header');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  // 2) Session + CSRF for the admin API.
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const key = `${req.method} ${url}`;
    const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    if (stateChanging && !originAllowed(ctx, req.headers.origin as string | undefined)) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }

    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      const idHash = sha256hex(sid);
      const s = ctx.adminRepo.getSession(idHash);
      if (s && s.expires_at > Date.now() && s.last_seen_at > Date.now() - SESSION_IDLE_MS) {
        req.session = { idHash, csrf: s.csrf };
        if (Date.now() - s.last_seen_at > 60_000) ctx.adminRepo.touchSession(idHash);
      }
    }

    if (PUBLIC_API.has(key)) {
      // Login/setup carry no session yet: require a JSON body so cross-site forms can't post them.
      if (stateChanging && !String(req.headers['content-type'] ?? '').includes('application/json')) {
        return reply.code(415).send({ error: 'json_required' });
      }
      return;
    }
    if (!req.session) return reply.code(401).send({ error: 'unauthenticated' });
    if (stateChanging) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, req.session.csrf)) {
        return reply.code(403).send({ error: 'csrf' });
      }
    }
  });

  const issueSession = (req: FastifyRequest, reply: FastifyReply) => {
    const sid = randomToken(32);
    const csrf = randomToken(24);
    ctx.adminRepo.createSession(sha256hex(sid), csrf, SESSION_TTL_MS, String(req.headers['user-agent'] ?? '').slice(0, 200));
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false, // admin listener is plain HTTP on loopback
      maxAge: SESSION_TTL_MS / 1000,
    });
    return csrf;
  };

  app.get('/api/auth/status', async (req) => ({
    setupRequired: !ctx.adminRepo.hasPassword(),
    authenticated: !!req.session,
    csrf: req.session?.csrf ?? null,
  }));

  const pwSchema = z.string().min(12, 'Use at least 12 characters').max(512);

  app.post('/api/auth/setup', async (req, reply) => {
    if (ctx.adminRepo.hasPassword()) return reply.code(409).send({ error: 'already_set_up' });
    const body = z.object({ password: pwSchema, setupCode: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    if (!ctx.setupCode || !safeEqual(body.data.setupCode.trim(), ctx.setupCode)) {
      return reply.code(403).send({ error: 'bad_setup_code', message: 'Setup code does not match the one printed in the server console.' });
    }
    ctx.adminRepo.setPasswordHash(await hashPassword(body.data.password));
    ctx.setupCode = null;
    const csrf = issueSession(req, reply);
    return { ok: true, csrf };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const now = Date.now();
    if (failures.lockedUntil > now) {
      return reply.code(429).send({ error: 'locked', retryInSec: Math.ceil((failures.lockedUntil - now) / 1000) });
    }
    const body = z.object({ password: z.string().max(512) }).safeParse(req.body);
    const h = ctx.adminRepo.getPasswordHash();
    if (!body.success || !h) return reply.code(400).send({ error: 'invalid' });
    const ok = await verifyPassword(h, body.data.password).catch(() => false);
    if (!ok) {
      failures.count++;
      if (failures.count >= 5) failures.lockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (failures.count - 5));
      return reply.code(401).send({ error: 'bad_password' });
    }
    failures.count = 0;
    failures.lockedUntil = 0;
    ctx.adminRepo.purgeExpired(SESSION_IDLE_MS);
    const csrf = issueSession(req, reply);
    return { ok: true, csrf };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) ctx.adminRepo.deleteSession(req.session.idHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const body = z.object({ current: z.string(), next: pwSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message });
    const h = ctx.adminRepo.getPasswordHash();
    if (!h || !(await verifyPassword(h, body.data.current).catch(() => false))) return reply.code(401).send({ error: 'bad_password' });
    ctx.adminRepo.setPasswordHash(await hashPassword(body.data.next));
    ctx.adminRepo.deleteAllSessions();
    const csrf = issueSession(req, reply);
    return { ok: true, csrf };
  });
}

export function _resetLoginLockoutForTests() {
  failures.count = 0;
  failures.lockedUntil = 0;
}
