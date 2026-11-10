import { isAllowed, NotAllowedError } from './allowlist.js';

export interface OutboundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer | null;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Hard cap on bytes read from the response (the rest is discarded). */
  readLimitBytes?: number;
}

export interface OutboundResult {
  /** Present when a response was received. */
  status?: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  size: number;
  contentType: string;
  durationMs: number;
  error?: string;
  blocked?: boolean;
  finalUrl: string;
  redirects: { status: number; location: string }[];
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  });
  const sc = h.getSetCookie?.();
  if (sc?.length) out['set-cookie'] = sc.join(', ');
  return out;
}

async function readCapped(res: Response, limit: number): Promise<{ body: Buffer; truncated: boolean; size: number }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false, size: 0 };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      truncated = true;
      const keep = value.byteLength - (size - limit);
      if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks), truncated, size };
}

/**
 * Send a request to an allowlisted host. Redirects are followed manually so every hop is
 * checked against the allowlist, and the Authorization header is only ever sent to the
 * original host.
 */
export async function sendOutbound(req: OutboundRequest, allowlist: string[]): Promise<OutboundResult> {
  const started = performance.now();
  const redirects: OutboundResult['redirects'] = [];
  let url = req.url;
  let method = req.method.toUpperCase();
  let headers = { ...req.headers };
  let body = req.body ?? null;
  const originalHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  const maxRedirects = req.maxRedirects ?? 5;

  const fail = (error: string, blocked = false): OutboundResult => ({
    headers: {},
    body: Buffer.alloc(0),
    truncated: false,
    size: 0,
    contentType: '',
    durationMs: performance.now() - started,
    error,
    blocked,
    finalUrl: url,
    redirects,
  });

  for (let hop = 0; ; hop++) {
    if (!isAllowed(url, allowlist)) return fail(new NotAllowedError(url).message, true);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body == null ? undefined : typeof body === "string" ? body : new Uint8Array(body),
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const msg = err.name === 'AbortError' ? `Timed out after ${req.timeoutMs ?? 60_000} ms` : (err.cause?.code ?? err.cause?.message ?? err.message);
      return fail(`Transport error: ${msg}`);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      const next = new URL(location, url).toString();
      redirects.push({ status: res.status, location: next });
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        delete headers['content-type'];
        delete headers['Content-Type'];
      }
      if (new URL(next).host !== originalHost) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
      }
      url = next;
      continue;
    }

    try {
      const { body: buf, truncated, size } = await readCapped(res, req.readLimitBytes ?? 25 * 1024 * 1024);
      clearTimeout(timer);
      return {
        status: res.status,
        headers: headersToRecord(res.headers),
        body: buf,
        truncated,
        size,
        contentType: res.headers.get('content-type') ?? '',
        durationMs: performance.now() - started,
        finalUrl: url,
        redirects,
      };
    } catch (e) {
      clearTimeout(timer);
      return { ...fail(`Error reading response: ${(e as Error).message}`), status: res.status, headers: headersToRecord(res.headers) };
    }
  }
}

export function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return !ct || ct.includes('json') || ct.startsWith('text/') || ct.includes('xml') || ct.includes('x-www-form-urlencoded') || ct.includes('javascript');
}
