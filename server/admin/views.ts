import type { ApiCallRow } from '../db/calls.js';
import type { WebhookRow } from '../db/webhooks.js';

const j = (s: string | null) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** API representation of a logged call (all values were redacted before storage). */
export function callView(r: ApiCallRow) {
  return {
    id: r.id,
    ts: r.ts,
    category: r.category,
    profileId: r.profile_id,
    authorizationId: r.authorization_id,
    authType: r.auth_type,
    grantType: r.grant_type,
    method: r.method,
    url: r.url,
    host: r.host,
    path: r.path,
    endpoint: r.endpoint,
    collectionRequestId: r.collection_request_id,
    savedRequestId: r.saved_request_id,
    query: r.query,
    requestHeaders: j(r.req_headers) ?? {},
    requestBody: r.req_body,
    status: r.status,
    statusClass: r.status_class,
    responseHeaders: j(r.resp_headers) ?? {},
    responseBody: r.resp_body,
    responseTruncated: !!r.resp_body_truncated,
    responseSize: r.resp_size,
    responseContentType: r.resp_content_type,
    durationMs: r.duration_ms,
    error: r.error,
    trackingId: r.tracking_id,
    zoomErrorCode: r.zoom_error_code,
    zoomErrorMessage: r.zoom_error_message,
    rateLimit: { category: r.rl_category, type: r.rl_type, limit: r.rl_limit, remaining: r.rl_remaining, reset: r.rl_reset, retryAfter: r.retry_after },
    attempt: r.attempt,
    retryOf: r.retry_of,
    replayOf: r.replay_of,
    redirects: j(r.redirects) ?? [],
  };
}

export function webhookView(r: WebhookRow, opts: { full?: boolean } = {}) {
  const raw = r.raw_body ? Buffer.from(r.raw_body) : null;
  return {
    id: r.id,
    receivedAt: r.received_at,
    profileId: r.profile_id,
    slug: r.slug,
    method: r.method,
    path: r.path,
    remoteIp: r.remote_ip,
    event: r.event,
    eventTs: r.event_ts,
    accountId: r.account_id,
    signature: r.signature,
    requestTs: r.request_ts,
    isValidation: !!r.is_validation,
    duplicateOf: r.duplicate_of,
    duplicateKind: r.duplicate_kind,
    trackingId: r.tracking_id,
    responseStatus: r.response_status,
    error: r.error,
    handleMs: r.handle_ms,
    bodySize: raw?.length ?? 0,
    ...(opts.full
      ? {
          requestHeaders: j(r.req_headers) ?? {},
          rawBody: raw ? raw.toString('utf8') : null,
          rawBodyBase64: raw && !isUtf8(raw) ? raw.toString('base64') : null,
          rawRedacted: !!r.raw_redacted,
          payload: j(r.payload),
          responseBody: r.response_body,
          bodyHash: r.body_hash,
        }
      : {}),
  };
}

function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}
