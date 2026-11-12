/**
 * Redaction applied before anything reaches a log table, an export, or application logs.
 *
 * Three layers:
 *  1. Header rules (Authorization, Cookie, ...).
 *  2. Key rules for JSON / form bodies (access_token, refresh_token, client_secret, ...).
 *  3. A registry of live secret values (decrypted client secrets, tokens, webhook secrets,
 *     ngrok authtoken). Any occurrence of a registered value anywhere in a string is replaced,
 *     which catches secrets in places the rules above don't anticipate.
 */

const SECRET_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-csrf-token']);

const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code_verifier',
  'subject_token',
  'password',
  'secret',
  'secret_token',
  'secrettoken',
  'webhook_secret',
  'authtoken',
  'ngrok_authtoken',
  'token',
]);

/** Keys that are only secret in OAuth token-endpoint traffic. */
const OAUTH_ONLY_KEYS = new Set(['code']);

export const REDACTED = '[REDACTED]';

export function mask(value: string, keep = 4): string {
  if (!value) return '';
  if (value.length <= keep * 2) return '•'.repeat(Math.max(4, value.length));
  return `${REDACTED}…${value.slice(-keep)}`;
}

class SecretRegistry {
  private values = new Set<string>();
  add(v: string | null | undefined) {
    // Very short values would cause false-positive replacements everywhere.
    if (v && v.length >= 8) this.values.add(v);
  }
  remove(v: string | null | undefined) {
    if (v) this.values.delete(v);
  }
  clear() {
    this.values.clear();
  }
  scrub(s: string): { text: string; changed: boolean } {
    let text = s;
    let changed = false;
    for (const v of this.values) {
      if (text.includes(v)) {
        text = text.split(v).join(mask(v));
        changed = true;
      }
    }
    return { text, changed };
  }
  get size() {
    return this.values.size;
  }
}

export const secrets = new SecretRegistry();

export function scrubString(s: string): string {
  return secrets.scrub(s).text;
}

export function redactHeaderValue(name: string, value: string): string {
  const n = name.toLowerCase();
  if (SECRET_HEADER_NAMES.has(n)) {
    const m = /^(Bearer|Basic)\s+(.+)$/i.exec(value);
    if (m) return `${m[1]} ${mask(m[2])}`;
    return mask(value);
  }
  return scrubString(value);
}

export function redactHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    out[k] = redactHeaderValue(k, val);
  }
  return out;
}

function redactValue(v: unknown, oauth: boolean): unknown {
  if (Array.isArray(v)) return v.map((x) => redactValue(x, oauth));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if ((SECRET_KEYS.has(lk) || (oauth && OAUTH_ONLY_KEYS.has(lk))) && (typeof x === 'string' || typeof x === 'number')) {
        out[k] = mask(String(x));
      } else out[k] = redactValue(x, oauth);
    }
    return out;
  }
  if (typeof v === 'string') return scrubString(v);
  return v;
}

/** Redact a JSON value (deep). */
export function redactJson<T>(v: T, opts: { oauth?: boolean } = {}): T {
  return redactValue(v, !!opts.oauth) as T;
}

/** Redact a form-encoded or query string ("a=1&b=2"). */
export function redactForm(s: string, opts: { oauth?: boolean } = {}): string {
  const params = new URLSearchParams(s);
  const parts: string[] = [];
  for (const [k, v] of params) {
    const lk = k.toLowerCase();
    const secret = SECRET_KEYS.has(lk) || (opts.oauth && OAUTH_ONLY_KEYS.has(lk));
    // Masked values are left readable (not percent-encoded) so logs stay legible.
    parts.push(`${encodeURIComponent(k)}=${secret ? mask(v) : encodeURIComponent(scrubString(v))}`);
  }
  return scrubString(parts.join('&'));
}

/** Redact a body of unknown shape: JSON is parsed and key-redacted, forms likewise, other text scrubbed. */
export function redactBody(body: string | null | undefined, contentType = '', opts: { oauth?: boolean } = {}): string | null {
  if (body == null) return null;
  const ct = contentType.toLowerCase();
  const trimmed = body.trimStart();
  if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJson(JSON.parse(body), opts));
    } catch {
      /* not JSON after all */
    }
  }
  if (ct.includes('x-www-form-urlencoded')) return redactForm(body, opts);
  return scrubString(body);
}

/** Redact a URL's query string. */
export function redactUrl(url: string, opts: { oauth?: boolean } = {}): string {
  try {
    const u = new URL(url);
    const q = u.search ? '?' + redactForm(u.search.slice(1), opts) : '';
    u.search = '';
    return scrubString(u.toString() + q);
  } catch {
    return scrubString(url);
  }
}
