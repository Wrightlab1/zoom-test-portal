import type { Ctx } from '../context.js';
import type { ProfilesRepo } from '../db/profiles.js';
import type { WebhooksRepo, WebhookRow } from '../db/webhooks.js';
import { sha256hex } from '../lib/crypto.js';
import { redactHeaders, secrets } from '../lib/redact.js';
import { timestampMs, urlValidationResponse, verifySignature } from '../lib/webhookSig.js';
import { trackingIdOf } from './callLog.js';

export type SignatureResult = 'valid' | 'invalid' | 'missing' | 'stale' | 'no_secret' | 'unknown_profile' | 'not_post';

export interface IncomingWebhook {
  method: string;
  path: string;
  slug: string | null;
  headers: Record<string, string | string[] | undefined>;
  raw: Buffer;
  remoteIp: string | null;
}

export interface WebhookResponse {
  status: number;
  body: string;
  contentType: string;
}

const header = (h: IncomingWebhook['headers'], name: string): string | null => {
  const v = h[name];
  return v == null ? null : Array.isArray(v) ? v[0] : v;
};

/**
 * Receives every request that reaches a webhook path — including bad ones — verifies it against
 * the profile's secret token, answers Zoom quickly, and records everything for inspection.
 */
export class WebhookReceiver {
  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private repo: WebhooksRepo,
  ) {}

  handle(req: IncomingWebhook): { response: WebhookResponse; id: number; row: Omit<WebhookRow, 'id'> } {
    const t0 = performance.now();
    const receivedAt = Date.now();
    const profile = req.slug ? this.profiles.getBySlug(req.slug) : null;

    let parsed: Record<string, any> | null = null;
    let parseError: string | null = null;
    if (req.raw.length) {
      try {
        const j = JSON.parse(req.raw.toString('utf8'));
        if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j;
        else parseError = 'Body is JSON but not an object';
      } catch (e) {
        parseError = `Invalid JSON: ${(e as Error).message}`;
      }
    } else parseError = 'Empty body';

    const event = typeof parsed?.event === 'string' ? parsed.event : null;
    const isValidation = event === 'endpoint.url_validation';
    const eventTs = typeof parsed?.event_ts === 'number' ? parsed.event_ts : Number.isFinite(Number(parsed?.event_ts)) && parsed?.event_ts != null ? Number(parsed.event_ts) : null;
    const accountId = typeof parsed?.payload?.account_id === 'string' ? parsed.payload.account_id : null;
    const sig = header(req.headers, 'x-zm-signature');
    const ts = header(req.headers, 'x-zm-request-timestamp');

    // ---- verification ----
    let result: SignatureResult;
    let error: string | null = null;
    if (!profile) {
      result = 'unknown_profile';
      error = req.slug ? `No profile with slug "${req.slug}"` : 'Not a profile webhook path';
    } else if (req.method !== 'POST') {
      result = 'not_post';
      error = `Method ${req.method} not allowed`;
    } else {
      const secret = this.profiles.webhookSecret(profile);
      if (!secret) {
        result = 'no_secret';
        error = 'Profile has no webhook secret token configured';
      } else if (!sig || !ts) {
        result = 'missing';
        error = `Missing ${!sig ? 'x-zm-signature' : ''}${!sig && !ts ? ' and ' : ''}${!ts ? 'x-zm-request-timestamp' : ''}`;
      } else if (!verifySignature(secret, ts, req.raw, sig)) {
        result = 'invalid';
        error = 'Signature does not match (wrong secret token, or body altered in transit)';
      } else {
        const tol = this.ctx.settings.get().webhookToleranceSec;
        const tms = timestampMs(ts);
        if (tol > 0 && (tms == null || Math.abs(receivedAt - tms) > tol * 1000)) {
          result = 'stale';
          error = tms == null ? 'Unparseable timestamp' : `Timestamp is ${Math.round((receivedAt - tms) / 1000)}s off (tolerance ${tol}s)`;
        } else result = 'valid';
      }
    }

    // ---- response ----
    let response: WebhookResponse;
    const text = (status: number, body: string): WebhookResponse => ({ status, body, contentType: 'text/plain; charset=utf-8' });
    if (result === 'unknown_profile') response = text(404, 'Not Found');
    else if (result === 'not_post') response = text(405, 'Method Not Allowed');
    else if (result !== 'valid') response = text(401, 'Unauthorized');
    else if (!parsed) {
      response = text(400, 'Bad Request');
      error = parseError;
    } else if (isValidation) {
      const plain = parsed.payload?.plainToken;
      if (typeof plain !== 'string' || !plain) {
        response = text(400, 'Bad Request');
        error = 'url_validation without payload.plainToken';
      } else {
        // Only answered for correctly signed requests: an unsigned validation request would turn
        // this endpoint into an HMAC oracle that forges signatures for arbitrary bodies.
        response = { status: 200, body: JSON.stringify(urlValidationResponse(this.profiles.webhookSecret(profile!)!, plain)), contentType: 'application/json' };
      }
    } else response = { status: 200, body: '', contentType: 'text/plain; charset=utf-8' };

    // ---- duplicate detection ----
    const bodyHash = req.raw.length ? sha256hex(req.raw) : null;
    let duplicateOf: number | null = null;
    let duplicateKind: string | null = null;
    if (bodyHash && profile && !isValidation) {
      duplicateOf = this.repo.findExactDuplicate(profile.id, bodyHash);
      if (duplicateOf) duplicateKind = 'identical_body';
      else if (event && eventTs != null) {
        duplicateOf = this.repo.findSameEvent(profile.id, event, eventTs);
        if (duplicateOf) duplicateKind = 'same_event_ts';
      }
    }

    // ---- record (raw body kept exactly, unless it contains one of our own secrets) ----
    let raw: Buffer | null = req.raw.length ? req.raw : null;
    let rawRedacted = 0;
    if (raw && secrets.size) {
      const s = raw.toString('utf8');
      const scrubbed = secrets.scrub(s);
      if (scrubbed.changed) {
        raw = Buffer.from(scrubbed.text, 'utf8');
        rawRedacted = 1;
      }
    }
    const row: Omit<WebhookRow, 'id'> = {
      received_at: receivedAt,
      profile_id: profile?.id ?? null,
      slug: req.slug,
      method: req.method,
      path: req.path,
      remote_ip: req.remoteIp,
      event,
      event_ts: eventTs,
      account_id: accountId,
      signature: result,
      request_ts: ts,
      is_validation: isValidation ? 1 : 0,
      duplicate_of: duplicateOf,
      duplicate_kind: duplicateKind,
      body_hash: bodyHash,
      tracking_id: trackingIdOf(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]))),
      req_headers: JSON.stringify(redactHeaders(req.headers)),
      raw_body: raw,
      raw_redacted: rawRedacted,
      payload: parsed ? secrets.scrub(JSON.stringify(parsed)).text : null,
      response_status: response.status,
      response_body: response.body || null,
      error,
      handle_ms: Math.round((performance.now() - t0) * 100) / 100,
    };
    const id = this.repo.insert(row);
    this.ctx.bus.emit('webhook', {
      id,
      receivedAt,
      profileId: row.profile_id,
      slug: row.slug,
      event,
      signature: result,
      isValidation,
      duplicateOf,
      duplicateKind,
      responseStatus: response.status,
      trackingId: row.tracking_id,
      accountId,
    });
    return { response, id, row };
  }
}
