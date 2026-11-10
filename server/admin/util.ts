import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { TokenError } from '../services/tokens.js';
import { OAuthConfigError } from '../services/oauthClient.js';
import { scrubString } from '../lib/redact.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  return schema.parse(v);
}

/** Uniform JSON errors for the admin API. Messages are scrubbed of known secrets. */
export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, _req, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: 'invalid', message: i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'Invalid input' });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: scrubString(err.message) });
    if (err instanceof TokenError) {
      const status = err.status && err.status >= 400 && err.status < 500 && [400, 404, 409].includes(err.status) ? err.status : 502;
      return reply.code(status).send({ error: err.code ?? 'token_error', message: scrubString(err.message), upstreamStatus: err.status });
    }
    if (err instanceof OAuthConfigError) return reply.code(400).send({ error: 'config', message: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: scrubString(e.message ?? '') });
    reply.log.error({ err }, 'unhandled admin error');
    return reply.code(500).send({ error: 'internal', message: 'Internal error — see server log.' });
  });
}
