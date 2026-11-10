import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Cipher, generateKey, loadMasterKey, KeyError, writeKeyFile } from '../server/lib/crypto.js';
import { openDb, migrate, verifyOrInitKey, reencryptAll, aad } from '../server/db/index.js';
import { tmpDir } from './helpers.js';

describe('Cipher (AES-256-GCM)', () => {
  const c = new Cipher(generateKey());

  it('round-trips unicode and long values', () => {
    for (const v of ['secret', 'ünïcødé 🔐', 'x'.repeat(100_000), '']) {
      expect(c.decrypt(c.encrypt(v, 'a.b'), 'a.b')).toBe(v);
    }
  });

  it('uses a fresh IV for every encryption', () => {
    expect(c.encrypt('same', 'a.b')).not.toBe(c.encrypt('same', 'a.b'));
  });

  it('fails with the wrong key', () => {
    const blob = c.encrypt('client-secret', 'profiles.client_secret_enc');
    const other = new Cipher(generateKey());
    expect(() => other.decrypt(blob, 'profiles.client_secret_enc')).toThrow(/wrong master key|tampered/);
  });

  it('fails when the AAD (column binding) differs', () => {
    const blob = c.encrypt('token', 'authorizations.access_token_enc');
    expect(() => c.decrypt(blob, 'authorizations.refresh_token_enc')).toThrow();
  });

  it('detects tampering', () => {
    const blob = c.encrypt('token', 'x.y');
    const raw = Buffer.from(blob.slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => c.decrypt('v1:' + raw.toString('base64url'), 'x.y')).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new Cipher(Buffer.alloc(16))).toThrow();
  });
});

describe('master key loading', () => {
  it('creates a 0600 key file on first run only', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'k', 'master.key');
    expect(() => loadMasterKey({ keyFile: file, firstRun: false })).toThrow(KeyError);
    const k = loadMasterKey({ keyFile: file, firstRun: true });
    expect(k.created).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = loadMasterKey({ keyFile: file, firstRun: false });
    expect(again.created).toBe(false);
    expect(again.key.equals(k.key)).toBe(true);
  });

  it('refuses a key file readable by others', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'master.key');
    writeKeyFile(file, generateKey());
    fs.chmodSync(file, 0o644);
    expect(() => loadMasterKey({ keyFile: file, firstRun: false })).toThrow(/chmod 600/);
  });

  it('prefers ZTP_MASTER_KEY and validates its length', () => {
    const key = generateKey();
    expect(loadMasterKey({ envKey: key.toString('base64'), keyFile: '/nonexistent', firstRun: false }).key.equals(key)).toBe(true);
    expect(() => loadMasterKey({ envKey: 'dG9vc2hvcnQ=', keyFile: '/nonexistent', firstRun: false })).toThrow(KeyError);
  });
});

describe('database key binding', () => {
  it('refuses to open with the wrong key and survives rotation', () => {
    const dir = tmpDir();
    const db = openDb(path.join(dir, 'p.db'));
    migrate(db);
    const k1 = new Cipher(generateKey());
    expect(verifyOrInitKey(db, k1)).toBe('initialized');
    expect(verifyOrInitKey(db, k1)).toBe('verified');
    expect(() => verifyOrInitKey(db, new Cipher(generateKey()))).toThrow(KeyError);

    const now = Date.now();
    db.prepare("INSERT INTO profiles (slug, name, type, client_id, client_secret_enc, created_at, updated_at) VALUES ('p','P','s2s','cid',?,?,?)").run(
      k1.encrypt('top-secret-value', aad('profiles', 'client_secret_enc')),
      now,
      now,
    );
    const k2 = new Cipher(generateKey());
    expect(reencryptAll(db, k1, k2)).toBeGreaterThanOrEqual(1);
    expect(() => verifyOrInitKey(db, k1)).toThrow(KeyError);
    expect(verifyOrInitKey(db, k2)).toBe('verified');
    const row = db.prepare('SELECT client_secret_enc FROM profiles').get() as { client_secret_enc: string };
    expect(k2.decrypt(row.client_secret_enc, aad('profiles', 'client_secret_enc'))).toBe('top-secret-value');
    db.close();
  });
});
