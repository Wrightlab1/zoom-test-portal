import type { CallsRepo, ApiCallRow, NewApiCall } from '../db/calls.js';
import type { OutboundResult } from '../lib/outbound.js';
import { isTextual } from '../lib/outbound.js';
import { redactBody, redactHeaders, redactUrl, redactForm, scrubString } from '../lib/redact.js';
import type { Bus } from '../context.js';

export interface RawCall {
  category: 'api' | 'token';
  profileId: number | null;
  authorizationId: number | null;
  authType: string | null;
  grantType?: string | null;
  method: string;
  url: string;
  endpoint?: string | null;
  collectionRequestId?: number | null;
  savedRequestId?: number | null;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  attempt?: number;
  retryOf?: number | null;
  replayOf?: number | null;
  result: OutboundResult;
}

export function statusClass(status: number | null | undefined, error?: string | null): string {
  if (status == null) return error ? 'error' : 'none';
  return `${Math.floor(status / 100)}xx`;
}

/** Zoom returns {code, message} for API errors and {error, reason} for OAuth errors. */
export function parseZoomError(body: string | null): { code: string | null; message: string | null } {
  if (!body) return { code: null, message: null };
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const code = j.code ?? j.error ?? null;
      const message = j.message ?? j.reason ?? j.error_description ?? null;
      return { code: code == null ? null : String(code), message: message == null ? null : String(message) };
    }
  } catch {
    /* not JSON */
  }
  return { code: null, message: null };
}

const h = (headers: Record<string, string>, name: string) => {
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
  return k ? headers[k] : null;
};
export const trackingIdOf = (headers: Record<string, string>) => {
  const k = Object.keys(headers).find((x) => x.toLowerCase().includes('trackingid'));
  return k ? headers[k] : null;
};
const num = (s: string | null) => (s == null || s === '' || isNaN(Number(s)) ? null : Number(s));

export class CallLogger {
  constructor(
    private repo: CallsRepo,
    private bus: Bus,
    private maxBodyBytes: () => number,
  ) {}

  log(c: RawCall): ApiCallRow {
    const oauth = c.category === 'token';
    const r = c.result;
    let host: string | null = null;
    let path: string | null = null;
    let query: string | null = null;
    try {
      const u = new URL(c.url);
      host = u.host;
      path = u.pathname;
      if (u.search) query = redactForm(u.search.slice(1), { oauth });
    } catch {
      /* invalid URL — stored as-is */
    }

    const reqCt = h(c.reqHeaders, 'content-type') ?? '';
    const limit = this.maxBodyBytes();
    let respBody: string | null = null;
    let respTruncated = r.truncated;
    if (r.status !== undefined) {
      if (isTextual(r.contentType)) {
        let buf = r.body;
        if (buf.length > limit) {
          buf = buf.subarray(0, limit);
          respTruncated = true;
        }
        respBody = redactBody(buf.toString('utf8'), r.contentType, { oauth });
      } else {
        respBody = `[binary body: ${r.size} bytes, ${r.contentType || 'unknown type'}]`;
      }
    }
    const zerr = r.status !== undefined && r.status >= 400 ? parseZoomError(respBody) : { code: null, message: null };

    const row: NewApiCall = {
      ts: Date.now() - Math.round(r.durationMs),
      category: c.category,
      profile_id: c.profileId,
      authorization_id: c.authorizationId,
      auth_type: c.authType,
      grant_type: c.grantType ?? null,
      method: c.method.toUpperCase(),
      url: redactUrl(c.url, { oauth }),
      host,
      path,
      endpoint: c.endpoint ?? path,
      collection_request_id: c.collectionRequestId ?? null,
      saved_request_id: c.savedRequestId ?? null,
      query,
      req_headers: JSON.stringify(redactHeaders(c.reqHeaders)),
      req_body: c.reqBody == null ? null : redactBody(c.reqBody.length > limit ? c.reqBody.slice(0, limit) : c.reqBody, reqCt, { oauth }),
      status: r.status ?? null,
      status_class: statusClass(r.status, r.error),
      resp_headers: r.status !== undefined ? JSON.stringify(redactHeaders(r.headers)) : null,
      resp_body: respBody,
      resp_body_truncated: respTruncated ? 1 : 0,
      resp_size: r.status !== undefined ? r.size : null,
      resp_content_type: r.contentType || null,
      duration_ms: Math.round(r.durationMs * 10) / 10,
      error: r.error ? scrubString(r.error) : null,
      tracking_id: trackingIdOf(r.headers),
      zoom_error_code: zerr.code,
      zoom_error_message: zerr.message,
      rl_category: h(r.headers, 'x-ratelimit-category'),
      rl_type: h(r.headers, 'x-ratelimit-type'),
      rl_limit: num(h(r.headers, 'x-ratelimit-limit')),
      rl_remaining: num(h(r.headers, 'x-ratelimit-remaining')),
      rl_reset: h(r.headers, 'x-ratelimit-reset'),
      retry_after: h(r.headers, 'retry-after'),
      attempt: c.attempt ?? 1,
      retry_of: c.retryOf ?? null,
      replay_of: c.replayOf ?? null,
      redirects: r.redirects.length ? JSON.stringify(r.redirects.map((x) => ({ status: x.status, location: redactUrl(x.location, { oauth }) }))) : null,
    };
    const id = this.repo.insert(row);
    const saved = { id, ...row } as ApiCallRow;
    this.bus.emit('call', { id, category: row.category, method: row.method, url: row.url, status: row.status, profileId: row.profile_id });
    return saved;
  }
}
