import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Cipher, DecryptError, KeyError } from '../lib/crypto.js';
import { migrations } from './migrations.js';

export type DB = Database.Database;

/**
 * Every encrypted column. Key rotation walks this list, so any new `_enc` column
 * must be added here. The AAD for a value is always "<table>.<column>".
 */
export const ENCRYPTED_COLUMNS: { table: string; pk: string; column: string }[] = [
  { table: 'profiles', pk: 'id', column: 'client_secret_enc' },
  { table: 'profiles', pk: 'id', column: 'webhook_secret_enc' },
  { table: 'authorizations', pk: 'id', column: 'access_token_enc' },
  { table: 'authorizations', pk: 'id', column: 'refresh_token_enc' },
  { table: 'oauth_pending', pk: 'state_hash', column: 'verifier_enc' },
  { table: 'collections', pk: 'id', column: 'variables_enc' },
  { table: 'environments', pk: 'id', column: 'values_enc' },
];
export const aad = (table: string, column: string) => `${table}.${column}`;

const KEY_CHECK_PLAINTEXT = 'zoom-test-portal key check v1';

export function dbExists(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Bind the database to a master key. A fresh database records an encrypted check value;
 * an existing one must decrypt it, otherwise the key is wrong and we refuse to continue.
 */
export function verifyOrInitKey(db: DB, cipher: Cipher): 'initialized' | 'verified' {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'key_check'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('key_check', ?)").run(cipher.encrypt(KEY_CHECK_PLAINTEXT, 'meta.key_check'));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('key_fingerprint', ?)").run(cipher.fingerprint);
    return 'initialized';
  }
  try {
    if (cipher.decrypt(row.value, 'meta.key_check') !== KEY_CHECK_PLAINTEXT) throw new DecryptError('mismatch');
  } catch {
    const fp = db.prepare("SELECT value FROM meta WHERE key = 'key_fingerprint'").get() as { value: string } | undefined;
    throw new KeyError(
      'The master key does not match this database.\n' +
        `  database expects key fingerprint: ${fp?.value ?? 'unknown'}\n` +
        `  supplied key fingerprint:         ${cipher.fingerprint}\n` +
        'Use the key that was in place when the database was created (check ZTP_MASTER_KEY / ZTP_KEY_FILE).',
    );
  }
  return 'verified';
}

/** Re-encrypt every secret with a new key in one transaction. */
export function reencryptAll(db: DB, from: Cipher, to: Cipher): number {
  let n = 0;
  db.transaction(() => {
    for (const c of ENCRYPTED_COLUMNS) {
      const rows = db.prepare(`SELECT ${c.pk} AS pk, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL`).all() as {
        pk: unknown;
        v: string;
      }[];
      const upd = db.prepare(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.pk} = ?`);
      for (const r of rows) {
        const a = aad(c.table, c.column);
        upd.run(to.encrypt(from.decrypt(r.v, a), a), r.pk);
        n++;
      }
    }
    const secrets = db.prepare('SELECT key, value FROM settings WHERE is_secret = 1 AND value IS NOT NULL').all() as {
      key: string;
      value: string;
    }[];
    for (const s of secrets) {
      const a = `settings.${s.key}`;
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(to.encrypt(from.decrypt(s.value, a), a), s.key);
      n++;
    }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'key_check'").run(to.encrypt(KEY_CHECK_PLAINTEXT, 'meta.key_check'));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('key_fingerprint', ?)").run(to.fingerprint);
  })();
  return n;
}
