/**
 * Outbound host allowlist.
 *
 * Entry forms:
 *   "api.zoom.us"              https only, default port, exact host
 *   "*.zoom.us"                https only, any subdomain (not the apex)
 *   "https://host:8443"        https on that exact port
 *   "http://127.0.0.1:4900"    plain http on that exact port (mock servers only)
 */
export interface ParsedEntry {
  scheme: 'https' | 'http';
  host: string;
  wildcard: boolean;
  port: string; // '' = default for scheme
  raw: string;
}

export function parseEntry(raw: string): ParsedEntry {
  const t = raw.trim().toLowerCase();
  if (!t) throw new Error('Empty allowlist entry');
  let scheme: 'https' | 'http' = 'https';
  let rest = t;
  const m = /^(https?):\/\/(.+)$/.exec(t);
  if (m) {
    scheme = m[1] as 'https' | 'http';
    rest = m[2];
  }
  rest = rest.replace(/\/.*$/, '');
  let wildcard = false;
  if (rest.startsWith('*.')) {
    wildcard = true;
    rest = rest.slice(2);
  }
  let host = rest;
  let port = '';
  const pm = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rest);
  if (!pm) throw new Error(`Invalid allowlist entry: ${raw}`);
  host = pm[1];
  port = pm[2] ?? '';
  if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) port = '';
  if (!/^[a-z0-9.\-[\]:]+$/.test(host) || host.includes('*')) throw new Error(`Invalid allowlist entry: ${raw}`);
  if (wildcard && host.split('.').length < 2) throw new Error(`Wildcard must cover a registrable domain: ${raw}`);
  return { scheme, host, wildcard, port, raw };
}

export function validateAllowlist(entries: string[]): string[] {
  return entries.map((e) => parseEntry(e).raw.trim());
}

export function isAllowed(url: string | URL, entries: string[]): boolean {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(':', '');
  if (scheme !== 'https' && scheme !== 'http') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  const port = u.port; // '' when default
  for (const raw of entries) {
    let e: ParsedEntry;
    try {
      e = parseEntry(raw);
    } catch {
      continue;
    }
    if (e.scheme !== scheme || e.port !== port) continue;
    if (e.wildcard ? host.endsWith('.' + e.host) : host === e.host) return true;
  }
  return false;
}

export class NotAllowedError extends Error {
  constructor(readonly url: string) {
    super(`Blocked by outbound allowlist: ${safeOrigin(url)} is not an allowed Zoom host. Edit the allowlist in Settings if this is intended.`);
  }
}

function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid URL)';
  }
}
