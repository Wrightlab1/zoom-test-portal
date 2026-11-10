import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AES-256-GCM envelope for secrets at rest.
 * Format: "v1:" + base64url(iv[12] | tag[16] | ciphertext). The AAD binds each value
 * to the field it belongs to (e.g. "profiles.client_secret") so values can't be swapped
 * between columns without detection.
 */
export class Cipher {
  readonly fingerprint: string;
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Master key must be exactly 32 bytes');
    this.fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }

  decrypt(blob: string, aad: string): string {
    if (!blob.startsWith('v1:')) throw new DecryptError('Unknown ciphertext format');
    const raw = Buffer.from(blob.slice(3), 'base64url');
    if (raw.length < 28) throw new DecryptError('Ciphertext too short');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(raw.subarray(12, 28));
    try {
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      throw new DecryptError('Decryption failed (wrong master key or tampered data)');
    }
  }

  encNullable(v: string | null | undefined, aad: string): string | null {
    return v == null || v === '' ? null : this.encrypt(v, aad);
  }
  decNullable(v: string | null | undefined, aad: string): string | null {
    return v == null ? null : this.decrypt(v, aad);
  }
}

export class DecryptError extends Error {}
export class KeyError extends Error {}

export function generateKey(): Buffer {
  return crypto.randomBytes(32);
}

export function parseKey(text: string): Buffer {
  const t = text.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== 32) throw new KeyError('Master key must decode to 32 bytes (base64 or hex)');
  return buf;
}

export function writeKeyFile(file: string, key: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export interface LoadedKey {
  key: Buffer;
  source: 'env' | 'file';
  created: boolean;
  file?: string;
}

/**
 * Resolve the master key. On first run (no database yet) a missing key file is created.
 * On later runs a missing key is fatal — we never fall back to plaintext.
 */
export function loadMasterKey(opts: { envKey?: string; keyFile: string; firstRun: boolean }): LoadedKey {
  if (opts.envKey) return { key: parseKey(opts.envKey), source: 'env', created: false };
  if (fs.existsSync(opts.keyFile)) {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(opts.keyFile).mode & 0o777;
      if (mode & 0o077) {
        throw new KeyError(
          `Master key file ${opts.keyFile} is accessible by other users (mode ${mode.toString(8)}).\n` +
            `Fix with: chmod 600 "${opts.keyFile}"`,
        );
      }
    }
    return { key: parseKey(fs.readFileSync(opts.keyFile, 'utf8')), source: 'file', created: false, file: opts.keyFile };
  }
  if (!opts.firstRun) {
    throw new KeyError(
      `Master key not found. Expected ZTP_MASTER_KEY or a key file at ${opts.keyFile}.\n` +
        'The database already exists, so a new key would not be able to read it. Restore your key backup ' +
        '(or point ZTP_KEY_FILE at it) and start again. The portal will not run without the key.',
    );
  }
  const key = generateKey();
  writeKeyFile(opts.keyFile, key);
  return { key, source: 'file', created: true, file: opts.keyFile };
}

export const sha256hex = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string compare that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}
