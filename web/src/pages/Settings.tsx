import { useEffect, useState } from 'react';
import { get, post, put } from '../api';
import { errMsg, useAsync } from '../hooks';
import { ErrorBanner, Field, Spinner, useToast } from '../components/ui';

export function SettingsPage() {
  const toast = useToast();
  const s = useAsync<any>(() => get('/api/settings'), []);
  const [form, setForm] = useState<any>(null);
  const [allow, setAllow] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [purgeDays, setPurgeDays] = useState(30);
  useEffect(() => {
    if (s.data) {
      setForm({ ...s.data });
      setAllow(s.data.allowlist.join('\n'));
    }
  }, [s.data]);
  if (!form) return <div className="page"><Spinner /></div>;
  const set = (patch: any) => setForm({ ...form, ...patch });
  const save = async () => {
    setErr(null);
    try {
      await put('/api/settings', {
        allowlist: allow.split('\n').map((x) => x.trim()).filter(Boolean),
        oauthBaseUrl: form.oauthBaseUrl,
        apiBaseUrl: form.apiBaseUrl,
        webhookToleranceSec: Number(form.webhookToleranceSec),
        retentionDays: Number(form.retentionDays),
        maxStoredBodyBytes: Number(form.maxStoredBodyBytes),
        refreshLeadSec: Number(form.refreshLeadSec),
        publicBaseUrlOverride: form.publicBaseUrlOverride,
      });
      toast('Settings saved');
      s.reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const nonZoom = allow.split('\n').map((x) => x.trim()).filter((x) => x && !/(^|\.)zoom\.us(:\d+)?$/.test(x.replace(/^https?:\/\//, '').replace(/^\*\./, '')));
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head"><h1>Settings</h1><span className="grow" /><button className="primary" onClick={save}>Save settings</button></div>
      <ErrorBanner error={err} />
      <div className="col" style={{ gap: 12, marginTop: 8 }}>
        <div className="card col">
          <h2>Outbound allowlist</h2>
          <div className="small muted">The backend only sends requests (API calls, token calls, redirects) to these hosts. One per line: <code>api.zoom.us</code>, <code>*.zoom.us</code>, or <code>http://127.0.0.1:4900</code> to permit plain HTTP to a mock server.</div>
          <textarea rows={8} value={allow} onChange={(e) => setAllow(e.target.value)} spellCheck={false} />
          {nonZoom.length > 0 && <div className="banner warn"><span className="icon">!</span><span>Non-Zoom hosts allowed: <code>{nonZoom.join(', ')}</code>. Profile tokens will be sent to them if you call them.</span></div>}
          <div><button className="sm" onClick={() => setAllow(form.defaultAllowlist.join('\n'))}>Reset to Zoom defaults</button></div>
        </div>
        <div className="card col">
          <h2>Zoom endpoints</h2>
          <div className="grid2">
            <Field label="OAuth base URL" hint="authorize / token / revoke. https://zoom.us unless you are testing against the mock."><input className="mono" value={form.oauthBaseUrl} onChange={(e) => set({ oauthBaseUrl: e.target.value })} /></Field>
            <Field label="Default API base URL" hint="Used when a token has no api_url. Normally https://api.zoom.us"><input className="mono" value={form.apiBaseUrl} onChange={(e) => set({ apiBaseUrl: e.target.value })} /></Field>
          </div>
          <Field label="Refresh lead time (seconds)" hint="Refresh user tokens / re-request S2S tokens when this much time is left"><input type="number" value={form.refreshLeadSec} onChange={(e) => set({ refreshLeadSec: e.target.value })} style={{ width: 120 }} /></Field>
        </div>
        <div className="card col">
          <h2>Webhooks</h2>
          <Field label="Replay tolerance (seconds)" hint="Reject signed requests whose x-zm-request-timestamp is further than this from now. 0 disables the check."><input type="number" value={form.webhookToleranceSec} onChange={(e) => set({ webhookToleranceSec: e.target.value })} style={{ width: 120 }} /></Field>
          <Field label="Public base URL override" hint="Use this instead of the ngrok URL (e.g. an external tunnel or reverse proxy). Leave empty to use ngrok."><input className="mono" value={form.publicBaseUrlOverride} onChange={(e) => set({ publicBaseUrlOverride: e.target.value })} placeholder="https://…" /></Field>
        </div>
        <div className="card col">
          <h2>Logs</h2>
          <div className="grid2">
            <Field label="Retention (days)" hint="Purge API call and webhook logs older than this. 0 = keep forever (default)."><input type="number" value={form.retentionDays} onChange={(e) => set({ retentionDays: e.target.value })} style={{ width: 120 }} /></Field>
            <Field label="Max stored body size (bytes)" hint="Request/response bodies beyond this are truncated in the log"><input type="number" value={form.maxStoredBodyBytes} onChange={(e) => set({ maxStoredBodyBytes: e.target.value })} style={{ width: 160 }} /></Field>
          </div>
          <div className="row">
            <span className="small">Purge now: older than</span>
            <input type="number" value={purgeDays} onChange={(e) => setPurgeDays(Number(e.target.value))} style={{ width: 80 }} />
            <span className="small">days</span>
            <button className="sm danger" onClick={async () => { if (!confirm(`Permanently delete logs older than ${purgeDays} days?`)) return; try { const r = await post('/api/logs/purge', { olderThanDays: purgeDays }); toast(`Deleted ${r.calls} calls and ${r.webhooks} webhooks`); } catch (e) { toast(errMsg(e), 'error'); } }}>Purge</button>
          </div>
        </div>
        <div className="card col">
          <h2>Security</h2>
          <dl className="kv">
            <dt>Admin listener</dt><dd>{form.admin.host}:{form.admin.port} {form.admin.loopback ? '(loopback only)' : <b style={{ color: 'var(--critical-text)' }}>NON-LOOPBACK — reachable from your network</b>}</dd>
            <dt>Public listener</dt><dd>{form.publicListener.host}:{form.publicListener.port} (tunnel target: callback + webhooks only)</dd>
            <dt>Data directory</dt><dd>{form.dataDir}</dd>
            <dt>Master key fingerprint</dt><dd>{form.keyFingerprint}</dd>
          </dl>
          <div className="small muted">The listener bind address and master key location are set with environment variables (see README); they cannot be changed from the UI.</div>
          <h3 style={{ marginTop: 8 }}>Change admin password</h3>
          <div className="row">
            <input type="password" placeholder="Current" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            <input type="password" placeholder="New (12+ chars)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
            <input type="password" placeholder="Confirm" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
            <button className="sm" disabled={!pw.current || pw.next.length < 12 || pw.next !== pw.confirm} onClick={async () => { try { await post('/api/auth/password', { current: pw.current, next: pw.next }); setPw({ current: '', next: '', confirm: '' }); toast('Password changed; other sessions signed out'); } catch (e) { toast(errMsg(e), 'error'); } }}>Change</button>
          </div>
        </div>
      </div>
    </div>
  );
}
