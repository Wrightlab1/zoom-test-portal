import { describe, it, expect } from 'vitest';
import { isAllowed, validateAllowlist } from '../server/lib/allowlist.js';
import { DEFAULT_ALLOWLIST } from '../server/db/settings.js';

describe('outbound allowlist', () => {
  it('allows Zoom API, OAuth and regional hosts over https', () => {
    for (const u of ['https://api.zoom.us/v2/users/me', 'https://zoom.us/oauth/token', 'https://api-eu.zoom.us/v2/x', 'https://api-au.zoom.us/v2']) {
      expect(isAllowed(u, DEFAULT_ALLOWLIST)).toBe(true);
    }
  });
  it('blocks other hosts, http, look-alikes, credentials-in-URL and odd ports', () => {
    for (const u of [
      'http://api.zoom.us/v2',
      'https://api.zoom.us.evil.com/v2',
      'https://evilzoom.us/',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/',
      'https://user:pass@api.zoom.us/v2',
      'https://api.zoom.us:8443/v2',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isAllowed(u, DEFAULT_ALLOWLIST), u).toBe(false);
    }
  });
  it('supports wildcards and explicit http entries with ports', () => {
    expect(isAllowed('https://file.zoom.us/x', ['*.zoom.us'])).toBe(true);
    expect(isAllowed('https://zoom.us/x', ['*.zoom.us'])).toBe(false);
    expect(isAllowed('http://127.0.0.1:4900/oauth/token', ['http://127.0.0.1:4900'])).toBe(true);
    expect(isAllowed('http://127.0.0.1:4901/oauth/token', ['http://127.0.0.1:4900'])).toBe(false);
    expect(isAllowed('https://127.0.0.1:4900/', ['http://127.0.0.1:4900'])).toBe(false);
  });
  it('validates entries', () => {
    expect(() => validateAllowlist(['*.us'])).toThrow();
    expect(() => validateAllowlist(['exa mple.com'])).toThrow();
    expect(validateAllowlist(['api.zoom.us'])).toEqual(['api.zoom.us']);
  });
});
