import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { errMsg, useAsync, useLive } from '../hooks';
import { Countdown, CopyLine, ErrorBanner, Field, Modal, Secret, Spinner, fmtTime, useToast } from '../components/ui';

export interface Authorization {
  id: number;
  profileId: number;
  kind: 's2s' | 'user';
  zoomUserId: string | null;
  zoomEmail: string | null;
  zoomName: string | null;
  zoomAccountId: string | null;
  scopes: string[];
  apiUrl: string | null;
  accessTokenHint: string | null;
  refreshTokenHint: string | null;
  accessExpiresAt: number | null;
  issuedAt: number | null;
  lastRefreshedAt: number | null;
  status: 'active' | 'failed' | 'revoked' | 'superseded';
  statusDetail: string | null;
  usedPkce: boolean;
  version: number;
}
export interface Profile {
  id: number;
  slug: string;
  name: string;
  type: 's2s' | 'user';
  clientId: string;
  clientSecretHint: string | null;
  accountId: string | null;
  webhookSecretHint: string | null;
  usePkce: boolean;
  autoRefresh: boolean;
  scopesRequested: string | null;
  notes: string | null;
  urls: { base: string; redirectUri: string; webhookUrl: string } | null;
  authorizations: Authorization[];
}

export const authLabel = (a: Authorization) => (a.kind === 's2s' ? 'Server-to-Server token' : a.zoomEmail ?? a.zoomName ?? `Authorization #${a.id}`);

export function ProfilesPage({ params, nav }: { params: URLSearchParams; nav: (p: string, q?: Record<string, string>) => void }) {
  const list = useAsync<Profile[]>(() => get('/api/profiles'), []);
  const selected = Number(params.get('id')) || list.data?.[0]?.id || null;
  const [creating, setCreating] = useState(false);
  useLive('token', () => list.reload());
  const select = (id: number) => nav('/profiles', { id: String(id) });

  return (
    <div className="split">
      <div className="pane" style={{ background: 'var(--surface)' }}>
        <div className="card-head">
          <h2 className="grow">Profiles</h2>
          <button className="sm primary" onClick={() => setCreating(true)}>+ New</button>
        </div>
        {list.loading && !list.data && <div className="empty"><Spinner /></div>}
        <ErrorBanner error={list.error} />
        {list.data?.length === 0 && <div className="empty">No profiles yet. A profile is one Zoom Marketplace app.</div>}
        <div>
          {list.data?.map((p) => {
            const active = p.authorizations.filter((a) => a.status === 'active');
            return (
              <div key={p.id} className={`tree item`} style={{ height: 'auto', padding: '8px 12px', borderBottom: '1px solid var(--border)', background: p.id === selected ? 'var(--accent-soft)' : undefined, cursor: 'pointer' }} onClick={() => select(p.id)}>
                <div className="col" style={{ gap: 2, minWidth: 0 }}>
                  <div className="row nowrap"><b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</b><span className="badge">{p.type === 's2s' ? 'S2S' : 'User OAuth'}</span></div>
                  <div className="muted small mono">{p.slug}</div>
                  <div className="small">{active.length ? <span className="badge good">{active.length} active token{active.length > 1 ? 's' : ''}</span> : <span className="badge">no token</span>}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pane">
        {selected && list.data?.find((p) => p.id === selected) ? (
          <ProfileDetail key={selected} profile={list.data.find((p) => p.id === selected)!} reload={list.reload} onDeleted={() => { nav('/profiles'); list.reload(); }} onDuplicated={(id) => { list.reload(); select(id); }} />
        ) : (
          !list.loading && <div className="empty">Select or create a profile.</div>
        )}
      </div>
      {creating && <ProfileForm onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); list.reload(); select(p.id); }} />}
    </div>
  );
}

function ProfileDetail({ profile: p, reload, onDeleted, onDuplicated }: { profile: Profile; reload: () => void; onDeleted: () => void; onDuplicated: (id: number) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const events = useAsync<any[]>(() => get(`/api/profiles/${p.id}/token-events`), [p.id]);
  const full = useAsync<Profile>(() => get(`/api/profiles/${p.id}`), [p.id]);
  useLive('token', (e) => {
    if (e.profileId === p.id) {
      events.reload();
      full.reload();
    }
  });
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try {
      await fn();
      if (ok) toast(ok);
      reload();
      full.reload();
      events.reload();
    } catch (e) {
      toast(errMsg(e), 'error');
      events.reload();
      full.reload();
    } finally {
      setBusy(null);
    }
  };
  const auths = (full.data ?? p).authorizations;
  const visible = auths.filter((a) => showOld || a.status !== 'superseded');
  const hidden = auths.length - visible.length;

  const authorize = async () => {
    try {
      const r = await post(`/api/profiles/${p.id}/authorize`, {});
      window.open(r.authorizeUrl, '_blank', 'noopener');
      toast('Opened Zoom consent in a new tab. This page updates when the callback arrives.');
      events.reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{p.name}</h1>
        <span className="badge">{p.type === 's2s' ? 'Server-to-Server OAuth' : 'General app · user OAuth'}</span>
        <span className="grow" />
        <button className="sm" onClick={() => setEditing(true)}>Edit</button>
        <button className="sm" onClick={() => run('dup', async () => onDuplicated((await post(`/api/profiles/${p.id}/duplicate`)).id), 'Duplicated')}>Duplicate</button>
        <button className="sm danger" onClick={() => confirm(`Delete profile "${p.name}" and its tokens? Logs are kept.`) && run('del', async () => { await del(`/api/profiles/${p.id}`); onDeleted(); })}>Delete</button>
      </div>

      <div className="grid2">
        <div className="card col">
          <h3>App credentials</h3>
          <dl className="kv">
            <dt>Slug</dt><dd>{p.slug}</dd>
            <dt>Client ID</dt><dd>{p.clientId}</dd>
            <dt>Client secret</dt><dd>{p.clientSecretHint ?? <span className="badge warn">not set</span>}</dd>
            {p.type === 's2s' && (<><dt>Account ID</dt><dd>{p.accountId}</dd></>)}
            <dt>Webhook secret</dt><dd>{p.webhookSecretHint ?? <span className="badge">not set</span>}</dd>
            {p.type === 'user' && (<><dt>PKCE</dt><dd>{p.usePkce ? 'S256' : 'off'}</dd></>)}
            {p.type === 'user' && p.scopesRequested && (<><dt>Scopes param</dt><dd>{p.scopesRequested}</dd></>)}
            <dt>Auto refresh</dt><dd>{p.autoRefresh ? 'on' : 'off'}</dd>
          </dl>
          {p.notes && <div className="small" style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>{p.notes}</div>}
        </div>
        <div className="card col">
          <h3>Marketplace values</h3>
          {p.urls ? (
            <>
              {p.type === 'user' && <CopyLine label="Redirect URL" value={p.urls.redirectUri} />}
              {p.type === 'user' && <CopyLine label="OAuth allow list" value={p.urls.redirectUri} />}
              <CopyLine label="Event endpoint" value={p.urls.webhookUrl} />
              <div className="muted small">Built from the current public URL ({new URL(p.urls.base).host}). Paste these exactly — Zoom requires an exact redirect match.</div>
            </>
          ) : (
            <div className="banner warn"><span className="icon">!</span><span>No public URL yet. Start the tunnel on <a href="#/tunnel">Tunnel &amp; URLs</a>.</span></div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{p.type === 's2s' ? 'Access token' : 'Authorizations'}</h3>
          <span className="grow" />
          {p.type === 's2s' ? (
            <button className="primary sm" disabled={!!busy} onClick={() => run('s2s', () => post(`/api/profiles/${p.id}/s2s-token`, { force: true }), 'New token issued')}>
              {busy === 's2s' ? <Spinner /> : null} Get new token
            </button>
          ) : (
            <button className="primary sm" onClick={authorize} disabled={!p.urls || !p.clientSecretHint} title={!p.urls ? 'Start the tunnel first' : undefined}>Authorize…</button>
          )}
        </div>
        {visible.length === 0 && <div className="muted small">{p.type === 's2s' ? 'No token yet. "Get new token" requests one with grant_type=account_credentials.' : 'No authorizations yet. "Authorize…" sends you through Zoom consent; each Zoom user you authorize as gets its own entry.'}</div>}
        <div className="col" style={{ gap: 10 }}>
          {visible.map((a) => (
            <AuthCard key={a.id} a={a} busy={busy} run={run} />
          ))}
        </div>
        {hidden > 0 && <button className="sm ghost" style={{ marginTop: 6 }} onClick={() => setShowOld(true)}>Show {hidden} superseded</button>}
      </div>

      <div className="card flush" style={{ marginTop: 12 }}>
        <div className="card-head"><h2 className="grow">Token events</h2><span className="muted small">issued · refreshed · revoked · failed (with Zoom’s error)</span></div>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          <table className="data">
            <thead><tr><th>Time</th><th>Event</th><th>Grant</th><th>HTTP</th><th>Zoom error</th><th>Detail</th><th /></tr></thead>
            <tbody>
              {events.data?.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtTime(e.at)}</td>
                  <td><span className={`badge ${e.kind === 'failed' ? 'bad' : e.kind === 'issued' || e.kind === 'refreshed' ? 'good' : e.kind === 'warning' ? 'warn' : ''}`}>{e.kind}</span>{e.authorization_id ? <span className="muted small"> #{e.authorization_id}</span> : null}</td>
                  <td className="mono small">{e.grant_type ?? ''}</td>
                  <td className="mono">{e.http_status ?? ''}</td>
                  <td>{e.error_code ? <><span className="mono">{e.error_code}</span> {e.error_message}</> : ''}</td>
                  <td className="small muted">{e.detail}</td>
                  <td>{e.api_call_id ? <a href={`#/calls?category=token&open=${e.api_call_id}`} className="small">call</a> : null}</td>
                </tr>
              ))}
              {events.data?.length === 0 && <tr><td colSpan={7} className="empty">No events yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <ProfileForm profile={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); full.reload(); }} />}
    </div>
  );
}

function AuthCard({ a, busy, run }: { a: Authorization; busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok?: string) => void }) {
  const reveal = (field: 'access_token' | 'refresh_token') => async () => (await post(`/api/authorizations/${a.id}/reveal`, { field })).value as string;
  const statusCls = a.status === 'active' ? 'good' : a.status === 'failed' ? 'bad' : a.status === 'revoked' ? 'warn' : '';
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>{authLabel(a)}</b>
        {a.zoomName && a.zoomEmail && <span className="muted small">{a.zoomName}</span>}
        <span className={`badge ${statusCls}`}>{a.status}</span>
        {a.status === 'active' && <Countdown to={a.accessExpiresAt} />}
        {a.usedPkce && <span className="badge info">PKCE</span>}
        <span className="grow" />
        {a.kind === 'user' && a.status !== 'superseded' && a.status !== 'revoked' && (
          <button className="sm" disabled={!!busy} onClick={() => run(`r${a.id}`, () => post(`/api/authorizations/${a.id}/refresh`), 'Refreshed (new refresh token stored)')}>{busy === `r${a.id}` ? <Spinner /> : null} Refresh now</button>
        )}
        {a.kind === 'user' && a.status === 'active' && !a.zoomUserId && <button className="sm" onClick={() => run(`l${a.id}`, () => post(`/api/authorizations/${a.id}/relabel`), 'Relabelled')}>Look up user</button>}
        {(a.status === 'active' || a.status === 'failed') && (
          <button className="sm danger" disabled={!!busy} onClick={() => confirm('Revoke this token at Zoom?') && run(`v${a.id}`, () => post(`/api/authorizations/${a.id}/revoke`), 'Revoked')}>Revoke</button>
        )}
        {a.status !== 'active' && <button className="sm ghost" onClick={() => run(`d${a.id}`, () => del(`/api/authorizations/${a.id}`))}>Remove</button>}
      </div>
      {a.statusDetail && <div className={`small ${a.status === 'failed' ? '' : 'muted'}`} style={{ marginBottom: 6, color: a.status === 'failed' ? 'var(--critical-text)' : undefined }}>{a.statusDetail}</div>}
      <div className="grid2">
        <div className="col" style={{ gap: 6 }}>
          <Field label="Access token"><Secret hint={a.accessTokenHint} fetchValue={reveal('access_token')} /></Field>
          {a.kind === 'user' && <Field label="Refresh token"><Secret hint={a.refreshTokenHint} fetchValue={reveal('refresh_token')} /></Field>}
        </div>
        <dl className="kv" style={{ alignContent: 'start' }}>
          <dt>api_url</dt><dd>{a.apiUrl ?? '—'}</dd>
          <dt>Expires</dt><dd>{fmtTime(a.accessExpiresAt)}</dd>
          <dt>Issued</dt><dd>{fmtTime(a.issuedAt)}</dd>
          {a.kind === 'user' && (<><dt>Refreshed</dt><dd>{fmtTime(a.lastRefreshedAt)}</dd></>)}
          {a.zoomUserId && (<><dt>Zoom user</dt><dd>{a.zoomUserId}</dd></>)}
          {a.zoomAccountId && (<><dt>Account</dt><dd>{a.zoomAccountId}</dd></>)}
          <dt>Scopes</dt>
          <dd style={{ fontFamily: 'var(--sans)' }}>{a.scopes.length ? <div className="row" style={{ gap: 4 }}>{a.scopes.map((s) => <span key={s} className="badge mono">{s}</span>)}</div> : '—'}</dd>
        </dl>
      </div>
    </div>
  );
}

function ProfileForm({ profile, onClose, onSaved }: { profile?: Profile; onClose: () => void; onSaved: (p: Profile) => void }) {
  const [f, setF] = useState({
    name: profile?.name ?? '',
    slug: profile?.slug ?? '',
    type: profile?.type ?? ('s2s' as 's2s' | 'user'),
    clientId: profile?.clientId ?? '',
    accountId: profile?.accountId ?? '',
    usePkce: profile?.usePkce ?? false,
    autoRefresh: profile?.autoRefresh ?? true,
    scopesRequested: profile?.scopesRequested ?? '',
    notes: profile?.notes ?? '',
  });
  // Secret fields are write-only: empty input means "keep the stored value".
  const [clientSecret, setClientSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [clear, setClear] = useState({ client: false, webhook: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  useEffect(() => setErr(null), [f]);

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ...f, slug: f.slug || undefined, accountId: f.type === 's2s' ? f.accountId : null, scopesRequested: f.scopesRequested || null, notes: f.notes || null };
      if (clientSecret) body.clientSecret = clientSecret;
      else if (clear.client) body.clientSecret = null;
      if (webhookSecret) body.webhookSecret = webhookSecret;
      else if (clear.webhook) body.webhookSecret = null;
      const r = profile ? await put(`/api/profiles/${profile.id}`, body) : await post('/api/profiles', body);
      onSaved(r);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={profile ? `Edit ${profile.name}` : 'New profile'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name || !f.clientId} onClick={save}>{profile ? 'Save' : 'Create'}</button></>}>
      <form className="col" onSubmit={(e) => { e.preventDefault(); save(); }} autoComplete="off">
        <div className="grid2">
          <Field label="Name"><input value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></Field>
          <Field label="Slug" hint="Used in the webhook and callback paths"><input className="mono" value={f.slug} placeholder="auto from name" onChange={(e) => set({ slug: e.target.value.toLowerCase() })} /></Field>
        </div>
        <Field label="App type">
          <div className="seg">
            <button type="button" className={f.type === 's2s' ? 'on' : ''} onClick={() => set({ type: 's2s' })}>Server-to-Server OAuth</button>
            <button type="button" className={f.type === 'user' ? 'on' : ''} onClick={() => set({ type: 'user' })}>General app (user OAuth)</button>
          </div>
        </Field>
        <div className="grid2">
          <Field label="Client ID"><input className="mono" value={f.clientId} onChange={(e) => set({ clientId: e.target.value.trim() })} /></Field>
          <Field label="Client secret" hint={profile?.clientSecretHint ? <>Stored: <span className="mono">{profile.clientSecretHint}</span> — leave blank to keep</> : 'Encrypted at rest; never shown again'}>
            <input className="mono" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={profile?.clientSecretHint ? '••••••••  (unchanged)' : ''} autoComplete="new-password" />
          </Field>
        </div>
        {f.type === 's2s' && <Field label="Account ID"><input className="mono" value={f.accountId} onChange={(e) => set({ accountId: e.target.value.trim() })} /></Field>}
        <Field label="Webhook secret token" hint={profile?.webhookSecretHint ? <>Stored: <span className="mono">{profile.webhookSecretHint}</span> — leave blank to keep</> : 'Feature → Event Subscriptions → Secret Token in the Marketplace'}>
          <input className="mono" type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={profile?.webhookSecretHint ? '••••••••  (unchanged)' : ''} autoComplete="new-password" />
        </Field>
        {profile && (profile.clientSecretHint || profile.webhookSecretHint) && (
          <div className="row small">
            {profile.clientSecretHint && <label className="check"><input type="checkbox" checked={clear.client} onChange={(e) => setClear({ ...clear, client: e.target.checked })} />Clear client secret</label>}
            {profile.webhookSecretHint && <label className="check"><input type="checkbox" checked={clear.webhook} onChange={(e) => setClear({ ...clear, webhook: e.target.checked })} />Clear webhook secret</label>}
          </div>
        )}
        {f.type === 'user' && (
          <>
            <label className="check"><input type="checkbox" checked={f.usePkce} onChange={(e) => set({ usePkce: e.target.checked })} />Use PKCE (S256) when authorizing</label>
            <Field label="scope parameter (optional)" hint="Leave blank to use the scopes configured on the app"><input className="mono" value={f.scopesRequested} onChange={(e) => set({ scopesRequested: e.target.value })} /></Field>
          </>
        )}
        <label className="check"><input type="checkbox" checked={f.autoRefresh} onChange={(e) => set({ autoRefresh: e.target.checked })} />{f.type === 's2s' ? 'Re-request the token automatically before it expires' : 'Refresh tokens automatically before they expire'}</label>
        <Field label="Notes"><textarea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} style={{ fontFamily: 'var(--sans)', fontSize: 13 }} /></Field>
        <ErrorBanner error={err} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
