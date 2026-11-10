import type { FastifyServerOptions } from 'fastify';
import { scrubString } from './redact.js';

/**
 * Application log options. Query strings are dropped from logged URLs (OAuth callbacks carry
 * `code` and `state`), headers are never logged, and every message passes through the
 * secret-value scrubber.
 */
export function loggerOptions(level: string, name: string): FastifyServerOptions['logger'] {
  if (level === 'silent') return false;
  return {
    level,
    name,
    serializers: {
      req(req: { method: string; url: string; ip?: string }) {
        const q = req.url.indexOf('?');
        return { method: req.method, url: q >= 0 ? req.url.slice(0, q) + '?…' : req.url, ip: req.ip };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
      err(err: Error) {
        return { type: err.name, message: scrubString(err.message), stack: scrubString(err.stack ?? '') };
      },
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a)) as typeof args;
        return method.apply(this, scrubbed);
      },
    },
  };
}
