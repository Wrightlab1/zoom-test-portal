import crypto from 'node:crypto';

export interface SendOptions {
  url: string;
  secret: string;
  /** Exact body bytes to send. Defaults to a sample event. */
  body?: string;
  event?: string;
  /** Sign with a different secret. */
  badSignature?: boolean;
  /** Omit signature headers. */
  noSignature?: boolean;
  /** Seconds to shift the timestamp into the past. */
  ageSec?: number;
  /** Sign this body but send a different one (simulates tampering in transit). */
  tamper?: boolean;
  headers?: Record<string, string>;
}

export function sampleEvent(event = 'meeting.started', overrides: Record<string, unknown> = {}) {
  return {
    event,
    event_ts: Date.now(),
    payload: {
      account_id: 'mockaccount1',
      object: { id: '99990707175', uuid: 'mock-uuid-abc==', host_id: 'mockuser001', topic: 'Mock meeting — ünïcødé', type: 2, start_time: new Date().toISOString() },
    },
    ...overrides,
  };
}

export function validationEvent(plainToken = crypto.randomBytes(16).toString('base64url')) {
  return { payload: { plainToken }, event_ts: Date.now(), event: 'endpoint.url_validation' };
}

export function sign(secret: string, ts: string, body: string | Buffer) {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex');
}

export async function sendWebhook(o: SendOptions) {
  const body = o.body ?? JSON.stringify(sampleEvent(o.event));
  const ts = String(Math.floor(Date.now() / 1000) - (o.ageSec ?? 0));
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'Zoom Marketplace/1.0a',
    'x-zm-trackingid': `v=2.0;clid=mock;rid=WEB_${crypto.randomBytes(16).toString('hex')}`,
    ...o.headers,
  };
  if (!o.noSignature) {
    headers['x-zm-request-timestamp'] = ts;
    headers['x-zm-signature'] = sign(o.badSignature ? o.secret + '-wrong' : o.secret, ts, body);
  }
  const sent = o.tamper ? body.replace(/}$/, ',"x":1}') : body;
  const res = await fetch(o.url, { method: 'POST', headers, body: sent });
  return { status: res.status, body: await res.text(), sentBody: sent };
}
