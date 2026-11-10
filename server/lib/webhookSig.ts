import crypto from 'node:crypto';

/**
 * Zoom webhook signature: "v0=" + hex(HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)).
 * The HMAC is computed over the exact request bytes — never over re-serialized JSON.
 */
export function computeSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  const h = crypto.createHmac('sha256', secret);
  h.update(`v0:${timestamp}:`, 'utf8');
  h.update(rawBody);
  return 'v0=' + h.digest('hex');
}

/** Constant-time comparison of the received header against the expected signature. */
export function verifySignature(secret: string, timestamp: string, rawBody: Buffer, received: string): boolean {
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'utf8');
  const got = Buffer.from(received.trim(), 'utf8');
  // Compare fixed-length digests so neither content nor length leaks through timing.
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b) && expected.length === got.length;
}

/** Response to `endpoint.url_validation`: encryptedToken = hex(HMAC-SHA256(secret, plainToken)). */
export function urlValidationResponse(secret: string, plainToken: string): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: crypto.createHmac('sha256', secret).update(plainToken).digest('hex') };
}

/** Parse x-zm-request-timestamp (seconds; tolerate milliseconds) to epoch ms. */
export function timestampMs(ts: string): number | null {
  if (!/^\d{1,16}$/.test(ts.trim())) return null;
  const n = Number(ts);
  return n > 1e12 ? n : n * 1000;
}
