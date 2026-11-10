import { useState } from 'react';
import { get, post, put } from '../api';
import { errMsg, useAsync, useLive } from '../hooks';
import { CopyButton, CopyLine, ErrorBanner, Field, Spinner, fmtTime, useToast } from '../components/ui';

export function TunnelPage() {
  const toast = useToast();
  const st = useAsync<any>(() => get('/api/tunnel'), []);
  const fields = useAsync<any[]>(() => get('/api/tunnel/marketplace-fields'), []);
  const settings = useAsync<any>(() => get('/api/settings'), []);
  const [busy, setBusy] = useState(false);
  const [authtoken, setAuthtoken] = useState('');
  const [domain, setDomain] = useState<string | null>(null);
  useLive('tunnel', (s) => {
    st.setData(s);
    fields.reload();
  });
  const s = st.data;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
      st.reload();
      fields.reload();
      settings.reload();
    }
  };
  const saveNgrok = () =>
    run(async () => {
      const body: Record<string, unknown> = {};
      if (authtoken) body.ngrokAuthtoken = authtoken;
      if (domain !== null) body.ngrokDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      await put('/api/settings', body);
      setAuthtoken('');
      setDomain(null);
      toast('ngrok settings saved');
    });

  const grouped = new Map<number, any[]>();
  for (const f of fields.data ?? []) grouped.set(f.profileId, [...(grouped.get(f.profileId) ?? []), f]);

  return (
    <div className="page">
      <div className="page-head"><h1>Tunnel &amp; Marketplace URLs</h1></div>
      {!s && <Spinner />}
      {s && (
        <div className="col" style={{ gap: 12 }}>
          {s.urlChanged && (
            <div className="banner warn" style={{ flexDirection: 'column' }}>
              <div><b>The public URL changed.</b> Zoom still has <code>{s.confirmedBase}</code>; it is now <code>{s.publicBase}</code>. Update these Marketplace fields, then confirm:</div>
              <table className="data" style={{ background: 'transparent' }}>
                <tbody>
                  {s.needsUpdate.map((f: any, i: number) => (
                    <tr key={i}><td>{f.profileName}</td><td>{f.field}</td><td className="url">{f.value}</td><td><CopyButton text={f.value} /></td></tr>
                  ))}
                </tbody>
              </table>
              <div><button className="primary sm" onClick={() => run(() => post('/api/tunnel/acknowledge'))}>I’ve updated the Marketplace</button></div>
            </div>
          )}
          {s.ephemeralWarning && !s.urlChanged && (
            <div className="banner warn"><span className="icon">!</span><span>No reserved domain set: ngrok assigns a new URL on every restart, and every Marketplace field below will need updating each time. Set your reserved (static) domain below.</span></div>
          )}

          <div className="grid2">
            <div className="card col">
              <div className="row">
                <h2 className="grow" style={{ margin: 0 }}>ngrok tunnel</h2>
                <span className={`badge ${s.state === 'running' ? 'good' : s.state === 'error' ? 'bad' : s.state === 'reconnecting' || s.state === 'starting' ? 'warn' : ''}`}>{s.state}</span>
              </div>
              {s.url ? <CopyLine label="Public URL" value={s.url} /> : <div className="muted small">Not running.</div>}
              {s.startedAt && <div className="small muted">Started {fmtTime(s.startedAt)}</div>}
              <ErrorBanner error={s.error} />
              <div className="small muted">Forwards only to the public listener <code>{s.forwardsTo}</code>, which serves nothing but the OAuth callback and webhook paths. The admin UI is on a separate listener and cannot be reached through the tunnel.</div>
              <div className="row">
                {s.state === 'running' || s.state === 'reconnecting' ? (
                  <button disabled={busy} onClick={() => run(() => post('/api/tunnel/stop'))}>Stop</button>
                ) : (
                  <button className="primary" disabled={busy || !s.hasAuthtoken} onClick={() => run(() => post('/api/tunnel/start'))}>{busy ? <Spinner /> : null} Start tunnel</button>
                )}
                {!s.hasAuthtoken && <span className="small muted">Add your ngrok authtoken first.</span>}
              </div>
              {s.baseSource === 'override' && <div className="banner info"><span className="icon">i</span><span>A public base URL override is set in Settings (<code>{s.publicBase}</code>); it is used instead of the tunnel URL.</span></div>}
            </div>
            <div className="card col">
              <h2 style={{ margin: 0 }}>ngrok settings</h2>
              <Field label="Authtoken" hint={settings.data?.ngrokAuthtokenHint ? <>Stored: <span className="mono">{settings.data.ngrokAuthtokenHint}</span> (encrypted)</> : 'From dashboard.ngrok.com → Your Authtoken'}>
                <input type="password" className="mono" value={authtoken} onChange={(e) => setAuthtoken(e.target.value)} placeholder={settings.data?.ngrokAuthtokenHint ? '••••••  (unchanged)' : ''} autoComplete="new-password" />
              </Field>
              <Field label="Reserved domain" hint="e.g. your-name.ngrok-free.app — keeps the URL stable across restarts">
                <input className="mono" value={domain ?? settings.data?.ngrokDomain ?? ''} onChange={(e) => setDomain(e.target.value)} placeholder="none (random URL each start)" />
              </Field>
              <label className="check small"><input type="checkbox" checked={!!settings.data?.ngrokAutostart} onChange={(e) => run(() => put('/api/settings', { ngrokAutostart: e.target.checked }))} />Start the tunnel when the portal starts</label>
              <div><button className="primary sm" disabled={busy || (!authtoken && domain === null)} onClick={saveNgrok}>Save</button> <span className="small muted">Restart the tunnel to apply a new domain.</span></div>
            </div>
          </div>

          <div className="card flush">
            <div className="card-head"><h2 className="grow">Values to paste into the Zoom Marketplace</h2>{s.publicBase && <span className="muted small">from {s.publicBase}</span>}</div>
            {!fields.data?.length ? (
              <div className="empty small">{s.publicBase ? 'Create a profile to see its URLs.' : 'Start the tunnel to get a public URL.'}</div>
            ) : (
              <table className="data">
                <thead><tr><th>Profile</th><th>App type</th><th>Marketplace field</th><th>Value</th><th /></tr></thead>
                <tbody>
                  {[...grouped.values()].flatMap((rows) =>
                    rows.map((f: any, i: number) => (
                      <tr key={`${f.profileId}-${i}`}>
                        <td>{i === 0 ? <a href={`#/profiles?id=${f.profileId}`}>{f.profileName}</a> : ''}</td>
                        <td>{i === 0 ? (f.appType === 's2s' ? 'Server-to-Server' : 'General (user OAuth)') : ''}</td>
                        <td>{f.field}</td>
                        <td className="url">{f.value}</td>
                        <td><CopyButton text={f.value} /></td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
            <div className="small muted" style={{ padding: '8px 12px' }}>Also paste each profile’s <b>Secret Token</b> from the Marketplace Event Subscriptions page into the profile (it is how the portal verifies signatures and answers URL validation).</div>
          </div>
        </div>
      )}
    </div>
  );
}
