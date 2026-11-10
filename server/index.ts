import { loadDotEnv } from './config.js';
import { createApp, StartupError } from './app.js';
import { KeyError } from './lib/crypto.js';

loadDotEnv();

function banner(lines: string[]) {
  const w = Math.max(...lines.map((l) => l.length));
  console.log('\n┌' + '─'.repeat(w + 2) + '┐');
  for (const l of lines) console.log('│ ' + l.padEnd(w) + ' │');
  console.log('└' + '─'.repeat(w + 2) + '┘\n');
}

async function main() {
  let app;
  try {
    app = await createApp();
  } catch (e) {
    if (e instanceof KeyError || e instanceof StartupError) {
      console.error('\n[zoom-test-portal] Refusing to start:\n\n' + e.message + '\n');
      process.exit(2);
    }
    throw e;
  }
  const { cfg } = app.ctx;
  if (app.key.created) {
    banner([
      'A new master key was generated:',
      `  ${app.key.file}`,
      '',
      'It encrypts every client secret, token and webhook secret in the database.',
      'BACK IT UP NOW (password manager or offline storage). Without it the',
      'database cannot be decrypted and the portal will refuse to start.',
      `Key fingerprint: ${app.ctx.cipher.fingerprint}`,
    ]);
  }
  if (cfg.adminHost !== '127.0.0.1' && cfg.adminHost !== 'localhost' && cfg.adminHost !== '::1') {
    banner([`WARNING: admin listener bound to ${cfg.adminHost} (non-loopback).`, 'Anyone who can reach this address can reach the login page.']);
  }
  const { adminUrl } = await app.start();
  const uiUrl = adminUrl.replace('0.0.0.0', '127.0.0.1');
  if (app.ctx.setupCode) {
    banner(['First run: open the portal and set an admin password.', `  ${uiUrl}`, `  Setup code: ${app.ctx.setupCode}`]);
  } else {
    console.log(`[zoom-test-portal] Admin UI: ${uiUrl}`);
  }
  console.log(`[zoom-test-portal] Public listener (tunnel target only): http://${cfg.publicHost}:${cfg.publicPort}`);

  const shutdown = async () => {
    await app!.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
