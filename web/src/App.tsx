import { useEffect, useState } from 'react';
import { get, onUnauthenticated, post, setCsrf } from './api';
import { closeStream, errMsg, useHashRoute, useLive, useLiveStatus } from './hooks';
import { ErrorBanner, Field, Spinner } from './components/ui';
import { ProfilesPage } from './pages/Profiles';
import { ExplorerPage } from './pages/Explorer';
import { CallsPage } from './pages/Calls';
import { WebhooksPage } from './pages/Webhooks';
import { TunnelPage } from './pages/Tunnel';
import { SettingsPage } from './pages/Settings';

type AuthState = { setupRequired: boolean; authenticated: boolean } | null;

export function App() {
  const [auth, setAuth] = useState<AuthState>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = () =>
    get('/api/auth/status')
      .then((s) => {
        setCsrf(s.csrf);
        setAuth(s);
      })
      .catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    check();
    return onUnauthenticated(() => {
      closeStream();
      setAuth((a) => (a ? { ...a, authenticated: false } : a));
    });
  }, []);
  if (err) return <div className="login"><ErrorBanner error={err} /></div>;
  if (!auth) return <div className="login"><Spinner /></div>;
  if (!auth.authenticated) return <Login setup={auth.setupRequired} onDone={check} />;
  return <Shell onLogout={() => { closeStream(); check(); }} />;
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (setup && pw !== pw2) return setErr('Passwords do not match');
    setBusy(true);
    try {
      if (setup) await post('/api/auth/setup', { password: pw, setupCode: code });
      else await post('/api/auth/login', { password: pw });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card col" onSubmit={submit} style={{ gap: 12 }}>
        <div className="row"><span className="logo" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', display: 'grid', placeItems: 'center', color: '#fff' }}>Z</span><h1>Zoom Test Portal</h1></div>
        {setup ? (
          <>
            <p className="muted small" style={{ margin: 0 }}>First run. Choose an admin password (12+ characters). The setup code is printed in the server console.</p>
            <Field label="Setup code"><input autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="mono" autoComplete="off" /></Field>
            <Field label="New password"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Confirm password"><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
          </>
        ) : (
          <Field label="Password"><input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
        )}
        <ErrorBanner error={err} />
        <button className="primary" disabled={busy || !pw}>{setup ? 'Set password' : 'Sign in'}</button>
      </form>
    </div>
  );
}

const NAV = [
  ['/profiles', 'Profiles & tokens'],
  ['/explorer', 'API explorer'],
  ['/calls', 'API calls'],
  ['/webhooks', 'Webhooks'],
  ['/tunnel', 'Tunnel & URLs'],
  ['/settings', 'Settings'],
] as const;

function Shell({ onLogout }: { onLogout: () => void }) {
  const [path, params, nav] = useHashRoute();
  const live = useLiveStatus();
  const [tunnel, setTunnel] = useState<any>(null);
  const [newHooks, setNewHooks] = useState(0);
  const [theme, setTheme] = useState<string>(document.documentElement.dataset.theme ?? 'auto');
  useEffect(() => {
    get('/api/tunnel').then(setTunnel).catch(() => {});
  }, []);
  useLive('tunnel', setTunnel);
  useLive('webhook', () => path !== '/webhooks' && setNewHooks((n) => n + 1));
  useEffect(() => {
    if (path === '/webhooks') setNewHooks(0);
  }, [path]);
  const cycleTheme = () => {
    const next = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto';
    setTheme(next);
    if (next === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('ztp.theme', next);
    } catch {
      /* ignore */
    }
  };
  const page = (() => {
    switch (path) {
      case '/explorer': return <ExplorerPage params={params} />;
      case '/calls': return <CallsPage params={params} />;
      case '/webhooks': return <WebhooksPage />;
      case '/tunnel': return <TunnelPage />;
      case '/settings': return <SettingsPage />;
      default: return <ProfilesPage params={params} nav={nav} />;
    }
  })();
  return (
    <div className="app">
      <nav className="nav">
        <div className="brand"><span className="logo">Z</span>Zoom Test Portal</div>
        {NAV.map(([p, label]) => (
          <a key={p} href={`#${p}`} className={path === p || (p === '/profiles' && !NAV.some((n) => n[0] === path)) ? 'active' : ''}>
            {label}
            {p === '/webhooks' && newHooks > 0 && <span className="badge info right">{newHooks}</span>}
            {p === '/tunnel' && tunnel?.urlChanged && <span className="badge warn right" title="Public URL changed">!</span>}
          </a>
        ))}
        <div className="spacer" />
        <div className="foot">
          <div className="row nowrap" title={tunnel?.publicBase ?? 'No public URL'}>
            <span className={`dot ${tunnel?.state === 'running' || tunnel?.baseSource === 'override' ? 'on' : tunnel?.state === 'error' ? 'bad' : ''}`} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tunnel?.publicBase ? new URL(tunnel.publicBase).host : 'Tunnel stopped'}</span>
          </div>
          <div className="row nowrap"><span className={`dot ${live ? 'on' : 'warn'}`} />{live ? 'Live updates on' : 'Reconnecting…'}</div>
          <div className="row">
            <button className="sm ghost" onClick={cycleTheme} title="Theme">Theme: {theme}</button>
            <button className="sm ghost" onClick={async () => { await post('/api/auth/logout'); onLogout(); }}>Sign out</button>
          </div>
        </div>
      </nav>
      <main className="main">{page}</main>
    </div>
  );
}
