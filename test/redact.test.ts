import { describe, it, expect, beforeEach } from 'vitest';
import { redactHeaders, redactBody, redactUrl, redactJson, secrets, scrubString } from '../server/lib/redact.js';

describe('redaction', () => {
  beforeEach(() => secrets.clear());

  it('masks Authorization and Cookie headers but keeps other headers', () => {
    const h = redactHeaders({
      Authorization: 'Bearer eyJhbGciOiJIUzUxMiJ9.longtokenvalue1234',
      cookie: 'session=abcdef1234567890',
      'x-zm-trackingid': 'v=2.0;clid=aw1;rid=WEB_abc',
      'Content-Type': 'application/json',
    });
    expect(h.Authorization).toMatch(/^Bearer \[REDACTED\]…1234$/);
    expect(h.Authorization).not.toContain('eyJhbGciOiJIUzUxMiJ9');
    expect(h.cookie).not.toContain('abcdef');
    expect(h['x-zm-trackingid']).toBe('v=2.0;clid=aw1;rid=WEB_abc');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('masks Basic credentials', () => {
    const b = Buffer.from('client:supersecretclientsecret').toString('base64');
    expect(redactHeaders({ authorization: `Basic ${b}` }).authorization).not.toContain(b);
  });

  it('redacts token fields in JSON bodies, deeply', () => {
    const out = JSON.parse(
      redactBody(
        JSON.stringify({ access_token: 'at-value-123456789', refresh_token: 'rt-value-987654321', scope: 'user:read', nested: [{ client_secret: 'cs-1234567890' }] }),
        'application/json',
      )!,
    );
    expect(out.access_token).not.toContain('at-value');
    expect(out.refresh_token).not.toContain('rt-value');
    expect(out.nested[0].client_secret).not.toContain('cs-12345');
    expect(out.scope).toBe('user:read');
  });

  it('redacts form bodies and OAuth-only fields like code/code_verifier', () => {
    const form = 'grant_type=authorization_code&code=abc123code456&redirect_uri=https%3A%2F%2Fx%2Fcb&code_verifier=verif-verif-verif';
    const out = redactBody(form, 'application/x-www-form-urlencoded', { oauth: true })!;
    expect(out).toContain('grant_type=authorization_code');
    expect(out).not.toContain('abc123code456');
    expect(out).not.toContain('verif-verif-verif');
    expect(out).toContain('redirect_uri=https%3A%2F%2Fx%2Fcb');
    // "code" is a normal key outside OAuth traffic (e.g. Zoom error bodies)
    expect(redactBody('{"code":124,"message":"Invalid access token."}', 'application/json')).toContain('"code":124');
  });

  it('redacts query string secrets in URLs', () => {
    const u = redactUrl('https://zoom.us/oauth/token?grant_type=refresh_token&refresh_token=rt-secret-abcdefgh', { oauth: true });
    expect(u).not.toContain('rt-secret-abcdefgh');
    expect(u).toContain('grant_type=refresh_token');
  });

  it('scrubs registered secret values anywhere, including free text', () => {
    secrets.add('my-live-client-secret-xyz');
    expect(scrubString('error: secret my-live-client-secret-xyz was rejected')).not.toContain('my-live-client-secret-xyz');
    expect(redactJson({ note: 'contains my-live-client-secret-xyz inline' }).note).not.toContain('my-live-client-secret-xyz');
    expect(redactHeaders({ 'x-custom': 'my-live-client-secret-xyz' })['x-custom']).not.toContain('my-live-client-secret-xyz');
  });

  it('ignores very short registered values to avoid false positives', () => {
    secrets.add('abc');
    expect(scrubString('abcdef')).toBe('abcdef');
  });

  it('leaves webhook plainToken alone (not a secret)', () => {
    expect(redactBody('{"payload":{"plainToken":"qgg8vlvZRS6UYooatFL8Aw"}}', 'application/json')).toContain('qgg8vlvZRS6UYooatFL8Aw');
  });
});
