/**
 * Send correctly or incorrectly signed webhooks to the portal.
 *
 *   npm run mock:webhook -- --url http://127.0.0.1:4801/webhooks/zoom/my-app --secret <token> [options]
 *
 * Options:
 *   --event <name>        event name (default meeting.started)
 *   --validation          send endpoint.url_validation and check the encryptedToken
 *   --bad-signature       sign with the wrong secret
 *   --no-signature        omit x-zm-signature / x-zm-request-timestamp
 *   --stale <sec>         backdate the timestamp
 *   --tamper              alter the body after signing
 *   --duplicate <n>       send the identical delivery n times (retries)
 *   --suite               run every case above once and print a summary
 */
import crypto from 'node:crypto';
import { sendWebhook, sampleEvent, validationEvent } from './webhookSender.js';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true') : undefined;
};
const url = opt('url');
const secret = opt('secret') ?? process.env.ZOOM_WEBHOOK_SECRET;
if (!url || !secret) {
  console.error('Usage: npm run mock:webhook -- --url <webhook url> --secret <secret token> [--suite|--validation|--bad-signature|...]');
  process.exit(1);
}

async function one(label: string, o: Parameters<typeof sendWebhook>[0], expect: number, check?: (body: string) => boolean) {
  const r = await sendWebhook(o);
  const ok = r.status === expect && (!check || check(r.body));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} -> ${r.status}${r.body ? '  ' + r.body.slice(0, 120) : ''}`);
  return ok;
}

const checkValidation = (plain: string) => (b: string) => {
  try {
    const j = JSON.parse(b);
    return j.plainToken === plain && j.encryptedToken === crypto.createHmac('sha256', secret).update(plain).digest('hex');
  } catch {
    return false;
  }
};

if (opt('suite')) {
  const plain = crypto.randomBytes(16).toString('base64url');
  const dup = JSON.stringify(sampleEvent('meeting.ended'));
  const results = [
    await one('valid event', { url, secret }, 200),
    await one('url_validation', { url, secret, body: JSON.stringify(validationEvent(plain)) }, 200, checkValidation(plain)),
    await one('unsigned url_validation', { url, secret, noSignature: true, body: JSON.stringify(validationEvent()) }, 401),
    await one('wrong secret', { url, secret, badSignature: true }, 401),
    await one('missing signature', { url, secret, noSignature: true }, 401),
    await one('stale timestamp (10 min)', { url, secret, ageSec: 600 }, 401),
    await one('body tampered after signing', { url, secret, tamper: true }, 401),
    await one('delivery #1', { url, secret, body: dup }, 200),
    await one('retry (identical delivery)', { url, secret, body: dup }, 200),
  ];
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `\n${failed} case(s) did not behave as expected.` : '\nAll cases behaved as expected. Check the Webhooks view for the flags.');
  process.exit(failed ? 1 : 0);
}

if (opt('validation')) {
  const plain = crypto.randomBytes(16).toString('base64url');
  process.exit((await one('url_validation', { url, secret, body: JSON.stringify(validationEvent(plain)) }, 200, checkValidation(plain))) ? 0 : 1);
}

const n = Number(opt('duplicate') ?? 1);
const body = JSON.stringify(sampleEvent(opt('event') ?? 'meeting.started'));
for (let i = 0; i < n; i++) {
  const r = await sendWebhook({
    url,
    secret,
    body,
    badSignature: !!opt('bad-signature'),
    noSignature: !!opt('no-signature'),
    ageSec: opt('stale') ? Number(opt('stale')) : 0,
    tamper: !!opt('tamper'),
  });
  console.log(`#${i + 1} -> ${r.status} ${r.body}`);
}
