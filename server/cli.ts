import fs from 'node:fs';
import readline from 'node:readline/promises';
import { configFromEnv, loadDotEnv } from './config.js';
import { Cipher, generateKey, loadMasterKey, writeKeyFile } from './lib/crypto.js';
import { dbExists, migrate, openDb, reencryptAll, verifyOrInitKey } from './db/index.js';
import { AdminRepo } from './db/sessions.js';
import { hashPassword } from './admin/auth.js';

loadDotEnv();
const cfg = configFromEnv();
const [cmd] = process.argv.slice(2);

function openVerified() {
  if (!dbExists(cfg.dbFile)) throw new Error(`No database at ${cfg.dbFile}`);
  const key = loadMasterKey({ envKey: cfg.masterKeyEnv, keyFile: cfg.keyFile, firstRun: false });
  const cipher = new Cipher(key.key);
  const db = openDb(cfg.dbFile);
  migrate(db);
  verifyOrInitKey(db, cipher);
  return { db, cipher, key };
}

async function rotateKey() {
  const { db, cipher, key } = openVerified();
  const backup = `${cfg.dbFile}.pre-rotate-${Date.now()}`;
  await db.backup(backup);
  fs.chmodSync(backup, 0o600);
  const nextKey = generateKey();
  const nextCipher = new Cipher(nextKey);
  const n = reencryptAll(db, cipher, nextCipher);
  db.close();
  if (key.source === 'file' && key.file) {
    const old = `${key.file}.old-${Date.now()}`;
    fs.copyFileSync(key.file, old);
    fs.chmodSync(old, 0o600);
    fs.rmSync(key.file);
    writeKeyFile(key.file, nextKey);
    console.log(`Re-encrypted ${n} secrets. New key written to ${key.file} (fingerprint ${nextCipher.fingerprint}).`);
    console.log(`Previous key kept at ${old} and database backup at ${backup} — delete both once you have backed up the new key.`);
  } else {
    console.log(`Re-encrypted ${n} secrets (fingerprint ${nextCipher.fingerprint}).`);
    console.log('Your key comes from ZTP_MASTER_KEY. Replace it with this value before restarting:\n');
    console.log('  ZTP_MASTER_KEY=' + nextKey.toString('base64') + '\n');
    console.log(`Database backup (readable with the OLD key) at ${backup}.`);
  }
}

async function resetPassword() {
  const { db } = openVerified();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question('New admin password (min 12 chars): ');
  rl.close();
  if (pw.length < 12) throw new Error('Password too short');
  const repo = new AdminRepo(db);
  repo.setPasswordHash(await hashPassword(pw));
  repo.deleteAllSessions();
  db.close();
  console.log('Password updated; all sessions signed out.');
}

const commands: Record<string, () => Promise<void>> = { 'rotate-key': rotateKey, 'reset-password': resetPassword };
if (!cmd || !commands[cmd]) {
  console.log('Usage: npm run cli -- <rotate-key|reset-password>');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
