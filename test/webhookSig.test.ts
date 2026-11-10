import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { computeSignature, verifySignature, urlValidationResponse, timestampMs } from '../server/lib/webhookSig.js';

const SECRET = 'unit-test-secret-token';
const ref = (ts: string, body: string | Buffer) => 'v0=' + crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`v0:${ts}:`), Buffer.from(body)])).digest('hex');

describe('webhook signature verification', () => {
  // Pretty-printed, unicode, odd key order and escaped characters: re-serializing would change the bytes.
  const raw = Buffer.from('{\n  "event": "meeting.started",  "payload": {"z":1,"a":"ünïcødé \\u00e9 \\/ 😀"},\n  "event_ts": 1700000000000\n}\n', 'utf8');
  const ts = '1700000000';

  it('matches the reference HMAC over the exact raw bytes', () => {
    expect(computeSignature(SECRET, ts, raw)).toBe(ref(ts, raw));
    expect(verifySignature(SECRET, ts, raw, ref(ts, raw))).toBe(true);
  });

  it('fails if the body is re-serialized from parsed JSON', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));
    expect(reserialized.equals(raw)).toBe(false);
    expect(verifySignature(SECRET, ts, reserialized, ref(ts, raw))).toBe(false);
  });

  it('is byte-exact (no string decoding of invalid UTF-8)', () => {
    const bin = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`v0:${ts}:`), bin])).digest('hex');
    expect(verifySignature(SECRET, ts, bin, sig)).toBe(true);
    expect(verifySignature(SECRET, ts, Buffer.from(bin.toString('utf8')), sig)).toBe(false);
  });

  it('rejects wrong secret, wrong timestamp, truncated and malformed signatures', () => {
    const good = ref(ts, raw);
    expect(verifySignature('other-secret', ts, raw, good)).toBe(false);
    expect(verifySignature(SECRET, '1700000001', raw, good)).toBe(false);
    expect(verifySignature(SECRET, ts, raw, good.slice(0, -1))).toBe(false);
    expect(verifySignature(SECRET, ts, raw, good.replace('v0=', 'v1='))).toBe(false);
    expect(verifySignature(SECRET, ts, raw, '')).toBe(false);
    expect(verifySignature(SECRET, ts, raw, good.toUpperCase())).toBe(false);
  });

  it('builds the URL validation response', () => {
    const r = urlValidationResponse(SECRET, 'qgg8vlvZRS6UYooatFL8Aw');
    expect(r.plainToken).toBe('qgg8vlvZRS6UYooatFL8Aw');
    expect(r.encryptedToken).toBe(crypto.createHmac('sha256', SECRET).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'));
    expect(r.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses timestamps in seconds (and tolerates ms)', () => {
    expect(timestampMs('1700000000')).toBe(1700000000000);
    expect(timestampMs('1700000000123')).toBe(1700000000123);
    expect(timestampMs('abc')).toBeNull();
  });
});
