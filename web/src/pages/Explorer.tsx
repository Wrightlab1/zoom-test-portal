import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put } from '../api';
import { errMsg, useAsync, useLocalState } from '../hooks';
import { BodyView, CopyButton, ErrorBanner, Field, HeadersTable, KeyValueEditor, Method, Modal, Spinner, StatusCode, Tabs, copyText, fmtBytes, fmtMs, useToast, type KVRow } from '../components/ui';
import type { Profile } from './Profiles';
import { authLabel } from './Profiles';

interface TreeData {
  folders: { id: number; parentId: number | null; name: string; sort: number }[];
  requests: { id: number; folderId: number | null; name: string; method: string; path: string; sort: number }[];
}
interface Collection {
  id: number;
  name: string;
  requestCount: number;
  updatedAt: number;
}
interface Env {
  id: number;
  name: string;
}

export interface EditorState {
  method: string;
  url: string;
  pathVariables: { key: string; value: string; description?: string; encoding: 'auto' | 'single' | 'double' }[];
  query: KVRow[];
  headers: KVRow[];
  body: string;
  collectionId: number | null;
  collectionRequestId: number | null;
  savedRequestId: number | null;
  savedName: string | null;
  title: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const blank = (): EditorState => ({ method: 'GET', url: '{{baseUrl}}/users/me', pathVariables: [], query: [], headers: [], body: '', collectionId: null, collectionRequestId: null, savedRequestId: null, savedName: null, title: 'Ad hoc request' });

/** Extract ":name" path variables from a URL, keeping values/descriptions for names that persist. */
function syncPathVars(url: string, prev: EditorState['pathVariables']): EditorState['pathVariables'] {
  const path = url.split('?')[0];
  const names = [...path.matchAll(/(?:^|\/):([A-Za-z_][\w.-]*)(?=\/|$)/g)].map((m) => m[1]);
  return names.map((n) => prev.find((p) => p.key === n) ?? { key: n, value: '', encoding: 'auto' as const });
}

function fromDefinition(r: any): EditorState {
  const d = r.definition;
  let body = '';
  const headers: KVRow[] = (d.headers ?? []).map((h: any) => ({ key: h.key, value: h.value, enabled: !h.disabled, description: h.description }));
  if (d.body?.mode === 'raw') body = d.body.raw ?? '';
  else if (d.body?.mode === 'urlencoded') {
    body = (d.body.urlencoded ?? []).filter((x: any) => !x.disabled).map((x: any) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value)}`).join('&');
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
  } else if (d.body?.mode === 'graphql') body = JSON.stringify({ query: d.body.graphql?.query ?? '', variables: d.body.graphql?.variables ? JSON.parse(d.body.graphql.variables || '{}') : {} }, null, 2);
  const url = `${d.host || '{{baseUrl}}'}${d.pathTemplate}`;
  return {
    method: r.method,
    url,
    pathVariables: (d.pathVariables ?? []).map((v: any) => ({ key: v.key, value: v.value ?? '', description: v.description, encoding: 'auto' })),
    query: (d.query ?? []).map((q: any) => ({ key: q.key, value: q.value ?? '', enabled: !q.disabled, description: q.description })),
    headers,
    body,
    collectionId: r.collectionId,
    collectionRequestId: r.id,
    savedRequestId: null,
    savedName: null,
    title: r.name,
  };
}

function toSendInput(s: EditorState, ctx: { profileId: number; authorizationId: number | null; environmentId: number | null; auth: 'profile' | 'none' }) {
  return {
    profileId: ctx.profileId,
    authorizationId: ctx.authorizationId,
    environmentId: ctx.environmentId,
    auth: ctx.auth,
    method: s.method,
    url: s.url,
    pathVariables: Object.fromEntries(s.pathVariables.map((p) => [p.key, p.value])),
    encoding: Object.fromEntries(s.pathVariables.map((p) => [p.key, p.encoding])),
    query: s.query.map(({ key, value, enabled }) => ({ key, value, enabled })),
    headers: s.headers.map(({ key, value, enabled }) => ({ key, value, enabled })),
    body: s.body || null,
    collectionId: s.collectionId,
    collectionRequestId: s.collectionRequestId,
    savedRequestId: s.savedRequestId,
  };
}

export function ExplorerPage({ params }: { params: URLSearchParams }) {
  const toast = useToast();
  const profiles = useAsync<Profile[]>(() => get('/api/profiles'), []);
  const collections = useAsync<Collection[]>(() => get('/api/collections'), []);
  const envs = useAsync<Env[]>(() => get('/api/environments'), []);
  const saved = useAsync<any[]>(() => get('/api/saved-requests'), []);
  const [profileId, setProfileId] = useLocalState<number | null>('ztp.explorer.profile', null);
  const [authId, setAuthId] = useLocalState<number | null>('ztp.explorer.auth', null);
  const [envId, setEnvId] = useLocalState<number | null>('ztp.explorer.env', null);
  const [collId, setCollId] = useLocalState<number | null>('ztp.explorer.collection', null);
  const [authMode, setAuthMode] = useState<'profile' | 'none'>('profile');
  const [state, setState] = useState<EditorState>(blank);
  const [def, setDef] = useState<any>(null);
  const [leftTab, setLeftTab] = useState<'collection' | 'saved'>('collection');
  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'docs'>('params');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ calls: any[]; warnings: string[] } | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const profile = profiles.data?.find((p) => p.id === profileId) ?? profiles.data?.[0];
  const activeAuths = profile?.authorizations.filter((a) => a.status === 'active') ?? [];
  const auth = profile?.type === 'user' ? (activeAuths.find((a) => a.id === authId) ?? activeAuths[0]) : activeAuths[0];
  const collection = collections.data?.find((c) => c.id === collId) ?? collections.data?.[0];

  // Deep links: #/explorer?call=123 or ?saved=4
  useEffect(() => {
    const callId = params.get('call');
    const savedId = params.get('saved');
    if (callId) {
      get(`/api/calls/${callId}/input`)
        .then((inp) => {
          setProfileId(inp.profileId);
          if (inp.authorizationId) setAuthId(inp.authorizationId);
          setAuthMode(inp.auth);
          setState({ ...blank(), method: inp.method, url: inp.url, headers: inp.headers.map((h: any) => ({ ...h })), body: inp.body ?? '', collectionRequestId: inp.collectionRequestId ?? null, title: `Re-run of call #${callId}` });
          setDef(null);
        })
        .catch((e) => toast(errMsg(e), 'error'));
    } else if (savedId && saved.data) {
      const s = saved.data.find((x) => x.id === Number(savedId));
      if (s) loadSaved(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('call'), params.get('saved'), saved.data]);

  const openRequest = useCallback(async (id: number) => {
    try {
      const r = await get(`/api/collection-requests/${id}`);
      setDef(r);
      setState(fromDefinition(r));
      setResult(null);
      setTab(r.definition.pathVariables?.length || r.definition.query?.length ? 'params' : r.method === 'GET' ? 'docs' : 'body');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }, [toast]);

  const loadSaved = (s: any) => {
    const r = s.request as EditorState;
    setState({ ...blank(), ...r, savedRequestId: s.id, savedName: s.name, title: s.name });
    if (s.profileId) setProfileId(s.profileId);
    if (s.authorizationId) setAuthId(s.authorizationId);
    setResult(null);
    if (s.collectionRequestId) get(`/api/collection-requests/${s.collectionRequestId}`).then(setDef).catch(() => setDef(null));
    else setDef(null);
  };

  const ctx = () => ({ profileId: profile!.id, authorizationId: profile?.type === 'user' ? (auth?.id ?? null) : null, environmentId: envId, auth: authMode });

  const send = async () => {
    if (!profile) return toast('Create a profile first', 'error');
    setSending(true);
    setSendErr(null);
    try {
      setResult(await post('/api/send', toSendInput(state, ctx())));
    } catch (e) {
      setSendErr(errMsg(e));
      setResult(null);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        setLeftTab('collection');
        setTimeout(() => document.getElementById('tree-search')?.focus(), 0);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const importFile = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      if (Array.isArray(json.values) && !json.item) {
        const r = await post('/api/environments/import', { environment: json });
        toast(`Environment "${r.environment.name}" ${r.created ? 'imported' : 'updated'}`);
        envs.reload();
        setEnvId(r.id);
      } else {
        const r = await post('/api/collections/import', { collection: json });
        toast(`${r.created ? 'Imported' : 'Updated'} "${r.name}": ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} removed${r.orphanedSavedRequests ? `, ${r.orphanedSavedRequests} saved request(s) now orphaned` : ''}${r.relinkedSavedRequests ? `, ${r.relinkedSavedRequests} re-linked` : ''}`);
        if (r.warnings?.length) toast(`Warnings: ${r.warnings.slice(0, 3).join('; ')}${r.warnings.length > 3 ? '…' : ''}`, 'error');
        collections.reload();
        saved.reload();
        setCollId(r.collectionId);
      }
    } catch (e) {
      toast(`Import failed: ${errMsg(e)}`, 'error');
    }
  };

  const last = result?.calls[result.calls.length - 1];

  return (
    <div className="split" style={{ gridTemplateColumns: '320px 1fr' }}>
      {/* ---------------- left: collection tree / saved ---------------- */}
      <div className="pane col" style={{ background: 'var(--surface)', gap: 0, overflow: 'hidden', display: 'flex' }}>
        <div style={{ padding: '8px 10px 0' }}>
          <Tabs tabs={[{ id: 'collection', label: 'Collection' }, { id: 'saved', label: 'Saved', count: saved.data?.length }]} value={leftTab} onChange={setLeftTab} />
        </div>
        {leftTab === 'collection' ? (
          <>
            <div className="row nowrap" style={{ padding: '0 10px 8px' }}>
              <select className="grow" value={collection?.id ?? ''} onChange={(e) => setCollId(Number(e.target.value))}>
                {!collections.data?.length && <option value="">No collections</option>}
                {collections.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.requestCount})</option>)}
              </select>
              <ImportButton onFile={importFile} />
              {collection && <button className="sm ghost icon" title="Delete collection" onClick={async () => { if (confirm(`Delete collection "${collection.name}"? Saved requests are kept.`)) { await del(`/api/collections/${collection.id}`); collections.reload(); saved.reload(); } }}>🗑</button>}
            </div>
            {collection ? <CollectionTree collectionId={collection.id} selected={state.collectionRequestId} onOpen={openRequest} /> : <div className="empty small">Import Zoom’s Postman collection (Collection v2.1 JSON) or a Postman environment file.</div>}
          </>
        ) : (
          <div style={{ overflow: 'auto', flex: 1 }}>
            {saved.data?.length === 0 && <div className="empty small">Save a request from the editor to keep its filled-in values.</div>}
            {saved.data?.map((s) => (
              <div key={s.id} className={`tree item ${state.savedRequestId === s.id ? 'on' : ''}`} style={{ padding: '0 10px' }} onClick={() => loadSaved(s)}>
                <Method m={s.request.method} />
                <span className="name grow">{s.name}</span>
                {s.orphaned && <span className="badge warn" title="The collection request this came from is gone. The saved values still work.">orphaned</span>}
                <button className="sm ghost icon" onClick={async (e) => { e.stopPropagation(); if (confirm(`Delete saved request "${s.name}"?`)) { await del(`/api/saved-requests/${s.id}`); saved.reload(); } }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- right: editor + response ---------------- */}
      <div className="pane">
        <div className="page" style={{ maxWidth: 'none' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h1 className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.title}</h1>
            {def && <span className="muted small mono">{def.matchKey}</span>}
            <button className="sm" onClick={() => { setState(blank()); setDef(null); setResult(null); }}>New ad hoc</button>
            {def && <button className="sm" onClick={() => setState(fromDefinition(def))}>Reset to definition</button>}
          </div>

          <div className="card" style={{ padding: 10 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <Field label="Profile">
                <select value={profile?.id ?? ''} onChange={(e) => setProfileId(Number(e.target.value))} style={{ minWidth: 180 }}>
                  {!profiles.data?.length && <option>No profiles</option>}
                  {profiles.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.type === 's2s' ? 'S2S' : 'user'}</option>)}
                </select>
              </Field>
              {profile?.type === 'user' && (
                <Field label="Authorization">
                  <select value={auth?.id ?? ''} onChange={(e) => setAuthId(Number(e.target.value))} style={{ minWidth: 200 }}>
                    {!activeAuths.length && <option value="">None active — authorize first</option>}
                    {activeAuths.map((a) => <option key={a.id} value={a.id}>{authLabel(a)}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Auth">
                <div className="seg">
                  <button className={authMode === 'profile' ? 'on' : ''} onClick={() => setAuthMode('profile')}>Bearer (profile)</button>
                  <button className={authMode === 'none' ? 'on' : ''} onClick={() => setAuthMode('none')} title="Send without the portal's token (e.g. to test a bad Authorization header)">None</button>
                </div>
              </Field>
              <Field label="Environment">
                <select value={envId ?? ''} onChange={(e) => setEnvId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">None</option>
                  {envs.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
              <span className="grow" />
              {auth?.apiUrl && <span className="muted small" title="{{baseUrl}} resolves to this api_url + /v2">{'{{baseUrl}}'} → <span className="mono">{auth.apiUrl}/v2</span></span>}
            </div>

            <div className="row nowrap">
              <select value={state.method} onChange={(e) => setState({ ...state, method: e.target.value })} style={{ width: 96, fontWeight: 700, fontFamily: 'var(--mono)' }}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="mono grow" value={state.url} onChange={(e) => setState({ ...state, url: e.target.value, pathVariables: syncPathVars(e.target.value, state.pathVariables) })} spellCheck={false} aria-label="URL" />
              <button className="primary" onClick={send} disabled={sending || !profile} title="⌘/Ctrl + Enter">{sending ? <Spinner /> : null} Send</button>
              <button className="sm" onClick={() => setSaveOpen(true)}>Save</button>
              <CurlMenu getInput={() => toSendInput(state, ctx())} disabled={!profile} />
            </div>

            <div style={{ marginTop: 8 }}>
              <Tabs
                tabs={[
                  { id: 'params', label: 'Params', count: state.pathVariables.length + state.query.filter((q) => q.enabled).length || null },
                  { id: 'headers', label: 'Headers', count: state.headers.filter((h) => h.enabled).length || null },
                  { id: 'body', label: 'Body' },
                  { id: 'docs', label: 'Docs & examples', count: def?.definition?.examples?.length || null },
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === 'params' && (
                <div className="col">
                  {state.pathVariables.length > 0 && (
                    <div>
                      <h3>Path variables</h3>
                      <div className="col" style={{ gap: 4 }}>
                        {state.pathVariables.map((pv, i) => {
                          const dbl = pv.encoding === 'double' || (pv.encoding === 'auto' && (pv.value.startsWith('/') || pv.value.includes('//')));
                          return (
                            <div key={pv.key}>
                              <div className="row nowrap">
                                <span className="mono" style={{ minWidth: 120 }}>:{pv.key}</span>
                                <input className="mono grow" value={pv.value} onChange={(e) => setState({ ...state, pathVariables: state.pathVariables.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                                <select value={pv.encoding} onChange={(e) => setState({ ...state, pathVariables: state.pathVariables.map((x, j) => (j === i ? { ...x, encoding: e.target.value as any } : x)) })} title="URL encoding" style={{ width: 150 }}>
                                  <option value="auto">auto{pv.encoding === 'auto' && dbl ? ' (double)' : ''}</option>
                                  <option value="single">encode once</option>
                                  <option value="double">double-encode</option>
                                </select>
                              </div>
                              {pv.description && <div className="muted small" style={{ marginLeft: 128 }}>{pv.description}</div>}
                            </div>
                          );
                        })}
                      </div>
                      <div className="muted small" style={{ marginTop: 4 }}>Auto double-encodes values that start with “/” or contain “//” (Zoom meeting UUID rule).</div>
                    </div>
                  )}
                  <div>
                    <h3>Query parameters</h3>
                    <KeyValueEditor rows={state.query} onChange={(query) => setState({ ...state, query })} />
                  </div>
                </div>
              )}
              {tab === 'headers' && (
                <div className="col">
                  <KeyValueEditor rows={state.headers} onChange={(headers) => setState({ ...state, headers })} keyPlaceholder="Header" />
                  <div className="muted small">{authMode === 'profile' ? 'Authorization: Bearer … is attached by the server; any Authorization header here is ignored.' : 'No auth: the portal sends exactly the headers above.'}</div>
                </div>
              )}
              {tab === 'body' && (
                <div className="col">
                  <textarea rows={12} value={state.body} onChange={(e) => setState({ ...state, body: e.target.value })} spellCheck={false} placeholder={state.method === 'GET' ? 'GET requests are sent without a body' : 'JSON body ({{variables}} are resolved)'} />
                  <div className="row">
                    <button className="sm" onClick={() => { try { setState({ ...state, body: JSON.stringify(JSON.parse(state.body), null, 2) }); } catch (e) { toast(`Not valid JSON: ${errMsg(e)}`, 'error'); } }}>Format JSON</button>
                  </div>
                </div>
              )}
              {tab === 'docs' && <Docs def={def} />}
            </div>
          </div>

          {/* ---------------- response ---------------- */}
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={sendErr} />
            {result?.warnings?.map((w, i) => (
              <div key={i} className="banner warn" style={{ marginBottom: 6 }}><span className="icon">!</span><span>{w}</span></div>
            ))}
            {last && <ResponsePanel calls={result!.calls} />}
            {!last && !sendErr && <div className="empty small">Send a request to see the response. Every call is logged under API calls.</div>}
          </div>
        </div>
      </div>
      {saveOpen && (
        <SaveDialog
          state={state}
          onClose={() => setSaveOpen(false)}
          onSaved={(s) => { setSaveOpen(false); saved.reload(); setState({ ...state, savedRequestId: s.id, savedName: s.name, title: s.name }); toast('Saved'); }}
          profileId={profile?.id ?? null}
          authorizationId={profile?.type === 'user' ? (auth?.id ?? null) : null}
        />
      )}
    </div>
  );
}

function ImportButton({ onFile }: { onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <button className="sm" onClick={() => ref.current?.click()} title="Import a Postman Collection v2.1 or environment JSON">Import</button>
    </>
  );
}

function CurlMenu({ getInput, disabled }: { getInput: () => unknown; disabled?: boolean }) {
  const toast = useToast();
  const copy = async (reveal: boolean) => {
    try {
      const r = await post('/api/send/curl', { ...(getInput() as object), reveal });
      await copyText(r.curl);
      toast(reveal ? 'curl copied (contains a live token)' : 'curl copied (token as $ZOOM_ACCESS_TOKEN)');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  return (
    <div className="row nowrap" style={{ gap: 2 }}>
      <button className="sm" disabled={disabled} onClick={() => copy(false)} title="Copy as curl with the token redacted">curl</button>
      <button className="sm ghost" disabled={disabled} onClick={() => confirm('Copy curl including the live access token?') && copy(true)} title="Copy as curl including the token">+token</button>
    </div>
  );
}

function Docs({ def }: { def: any }) {
  const [ex, setEx] = useState(0);
  if (!def) return <div className="muted small">Ad hoc request — no collection definition.</div>;
  const examples = def.definition.examples ?? [];
  return (
    <div className="col">
      {def.description && <div className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{def.description}</div>}
      {examples.length > 0 && (
        <div>
          <h3>Saved example responses</h3>
          <div className="row" style={{ marginBottom: 6 }}>
            {examples.map((e: any, i: number) => (
              <button key={i} className={`sm ${i === ex ? 'primary' : ''}`} onClick={() => setEx(i)}>{e.code ?? '—'} {e.status ?? ''}</button>
            ))}
          </div>
          <div className="muted small" style={{ marginBottom: 4 }}>{examples[ex]?.name}</div>
          <BodyView body={examples[ex]?.body} emptyText="(empty body)" />
        </div>
      )}
    </div>
  );
}

export function RateLimitBadges({ rl }: { rl: any }) {
  if (!rl?.category && rl?.limit == null) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {rl.category && <span className="badge info" title="X-RateLimit-Category">{rl.category}</span>}
      {rl.type && <span className="badge" title="X-RateLimit-Type">{rl.type}</span>}
      {rl.limit != null && <span className={`badge ${rl.remaining === 0 ? 'bad' : rl.remaining != null && rl.remaining / rl.limit < 0.2 ? 'warn' : ''}`} title="X-RateLimit-Remaining / Limit">{rl.remaining}/{rl.limit} left</span>}
      {rl.retryAfter && <span className="badge warn" title="Retry-After">retry after {rl.retryAfter}</span>}
    </span>
  );
}

export function ResponsePanel({ calls }: { calls: any[] }) {
  const [i, setI] = useState(calls.length - 1);
  const [tab, setTab] = useState<'body' | 'headers' | 'request'>('body');
  useEffect(() => setI(calls.length - 1), [calls]);
  const c = calls[i] ?? calls[calls.length - 1];
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <StatusCode status={c.status} error={c.error} />
        {c.zoomErrorCode && <span className="mono small">code {c.zoomErrorCode}</span>}
        {c.zoomErrorMessage && <span className="small">{c.zoomErrorMessage}</span>}
        <span className="badge">{fmtMs(c.durationMs)}</span>
        <span className="badge">{fmtBytes(c.responseSize)}</span>
        <RateLimitBadges rl={c.rateLimit} />
        <span className="grow" />
        {c.trackingId && (
          <span className="row nowrap small" title="Zoom tracking ID — quote this to Zoom support">
            <span className="muted">Tracking ID</span><code>{c.trackingId}</code><CopyButton text={c.trackingId} />
          </span>
        )}
        <a className="small" href={`#/calls?open=${c.id}`}>log #{c.id}</a>
      </div>
      {calls.length > 1 && (
        <div className="banner info" style={{ marginBottom: 8 }}>
          <span className="icon">↻</span>
          <span className="grow">Got 401 “expired”, refreshed the token and retried once. Both attempts are logged.</span>
          <div className="seg">{calls.map((x, j) => <button key={x.id} className={j === i ? 'on' : ''} onClick={() => setI(j)}>Attempt {x.attempt}: {x.status ?? 'ERR'}</button>)}</div>
        </div>
      )}
      {c.error && <ErrorBanner error={c.error} />}
      <div className="mono small muted" style={{ wordBreak: 'break-all', marginBottom: 6 }}><Method m={c.method} /> {c.url}</div>
      {c.redirects?.length > 0 && <div className="small muted" style={{ marginBottom: 6 }}>Redirects: {c.redirects.map((r: any) => `${r.status} → ${r.location}`).join(' · ')}</div>}
      <Tabs tabs={[{ id: 'body', label: 'Response body' }, { id: 'headers', label: 'Response headers', count: Object.keys(c.responseHeaders ?? {}).length }, { id: 'request', label: 'Request sent' }]} value={tab} onChange={setTab} />
      {tab === 'body' && (
        <>
          {c.responseTruncated && <div className="banner warn" style={{ marginBottom: 6 }}><span className="icon">!</span><span>Stored body truncated (limit in Settings).</span></div>}
          <BodyView body={c.responseBody} contentType={c.responseContentType} />
        </>
      )}
      {tab === 'headers' && <HeadersTable headers={c.responseHeaders ?? {}} highlight={['ratelimit', 'trackingid', 'retry-after']} />}
      {tab === 'request' && (
        <div className="col">
          <HeadersTable headers={c.requestHeaders ?? {}} />
          <BodyView body={c.requestBody} emptyText="No request body" />
        </div>
      )}
    </div>
  );
}

function SaveDialog({ state, onClose, onSaved, profileId, authorizationId }: { state: EditorState; onClose: () => void; onSaved: (s: any) => void; profileId: number | null; authorizationId: number | null }) {
  const [name, setName] = useState(state.savedName ?? state.title);
  const [asNew, setAsNew] = useState(!state.savedRequestId);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      const { savedRequestId, savedName, ...request } = state;
      void savedName;
      const body = { name, collectionRequestId: state.collectionRequestId, profileId, authorizationId, request: { ...request, title: name } };
      onSaved(asNew || !savedRequestId ? await post('/api/saved-requests', body) : await put(`/api/saved-requests/${savedRequestId}`, body));
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <Modal title="Save request" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={save}>Save</button></>}>
      <div className="col">
        <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
        {state.savedRequestId && <label className="check"><input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} />Save as a new request instead of updating “{state.savedName}”</label>}
        <div className="muted small">Saves method, URL, path variables, query, headers and body. Saved requests survive collection re-imports.</div>
        <ErrorBanner error={err} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ collection tree (virtualized)

type Row = { kind: 'folder'; id: number; name: string; depth: number; open: boolean; count: number } | { kind: 'req'; id: number; name: string; method: string; path: string; depth: number; crumb?: string };
const ROW_H = 24;

function CollectionTree({ collectionId, selected, onOpen }: { collectionId: number; selected: number | null; onOpen: (id: number) => void }) {
  const tree = useAsync<TreeData>(() => get(`/api/collections/${collectionId}/tree`), [collectionId]);
  const [q, setQ] = useState('');
  const [openSet, setOpenSet] = useLocalState<number[]>(`ztp.tree.${collectionId}`, []);
  const open = useMemo(() => new Set(openSet), [openSet]);
  const [method, setMethod] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });

  const rows = useMemo<Row[]>(() => {
    const t = tree.data;
    if (!t) return [];
    const children = new Map<number | null, TreeData['folders']>();
    for (const f of t.folders) {
      const k = f.parentId;
      if (!children.has(k)) children.set(k, []);
      children.get(k)!.push(f);
    }
    const reqsBy = new Map<number | null, TreeData['requests']>();
    for (const r of t.requests) {
      if (!reqsBy.has(r.folderId)) reqsBy.set(r.folderId, []);
      reqsBy.get(r.folderId)!.push(r);
    }
    const countUnder = (fid: number): number => (reqsBy.get(fid)?.length ?? 0) + (children.get(fid) ?? []).reduce((a, f) => a + countUnder(f.id), 0);
    const needle = q.trim().toLowerCase();
    if (needle || method) {
      const folderName = new Map(t.folders.map((f) => [f.id, f]));
      const crumb = (fid: number | null) => {
        const parts: string[] = [];
        let cur = fid;
        while (cur != null) {
          const f = folderName.get(cur);
          if (!f) break;
          parts.unshift(f.name);
          cur = f.parentId;
        }
        return parts.join(' › ');
      };
      return t.requests
        .filter((r) => (!method || r.method === method) && (!needle || r.name.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle)))
        .map((r) => ({ kind: 'req' as const, id: r.id, name: r.name, method: r.method, path: r.path, depth: 0, crumb: crumb(r.folderId) }));
    }
    const out: Row[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const f of children.get(parent) ?? []) {
        const isOpen = open.has(f.id);
        out.push({ kind: 'folder', id: f.id, name: f.name, depth, open: isOpen, count: countUnder(f.id) });
        if (isOpen) walk(f.id, depth + 1);
      }
      for (const r of reqsBy.get(parent) ?? []) out.push({ kind: 'req', id: r.id, name: r.name, method: r.method, path: r.path, depth });
    };
    walk(null, 0);
    return out;
  }, [tree.data, q, method, open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scroll.top / ROW_H) - 10);
  const end = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + 10);
  const hl = (s: string) => {
    const n = q.trim().toLowerCase();
    if (!n) return s;
    const i = s.toLowerCase().indexOf(n);
    return i < 0 ? s : <>{s.slice(0, i)}<mark>{s.slice(i, i + n.length)}</mark>{s.slice(i + n.length)}</>;
  };
  const toggle = (id: number) => setOpenSet(open.has(id) ? openSet.filter((x) => x !== id) : [...openSet, id]);

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="row nowrap" style={{ padding: '0 10px 8px' }}>
        <input className="grow" placeholder="Search name or path…  (/ to focus)" value={q} onChange={(e) => setQ(e.target.value)} id="tree-search" />
        <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 82 }} aria-label="Method filter">
          <option value="">All</option>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      {!q && !method && tree.data && (
        <div className="row small" style={{ padding: '0 10px 6px' }}>
          <button className="sm ghost" onClick={() => setOpenSet(tree.data!.folders.map((f) => f.id))}>Expand all</button>
          <button className="sm ghost" onClick={() => setOpenSet([])}>Collapse all</button>
          <span className="muted right">{tree.data.requests.length} requests</span>
        </div>
      )}
      {(q || method) && <div className="muted small" style={{ padding: '0 10px 6px' }}>{rows.length} match{rows.length === 1 ? '' : 'es'}</div>}
      <div ref={scrollRef} className="tree" style={{ flex: 1, overflow: 'auto', minHeight: 0 }} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
        {tree.loading && !tree.data && <div className="empty"><Spinner /></div>}
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(start, end).map((r, k) => {
            const top = (start + k) * ROW_H;
            if (r.kind === 'folder')
              return (
                <div key={`f${r.id}`} className="item folder" style={{ position: 'absolute', top, left: 0, right: 0, paddingLeft: 10 + r.depth * 14 }} onClick={() => toggle(r.id)}>
                  <span style={{ width: 10 }}>{r.open ? '▾' : '▸'}</span>
                  <span className="name">{r.name}</span>
                  <span className="muted small" style={{ fontWeight: 400 }}>{r.count}</span>
                </div>
              );
            return (
              <div key={`r${r.id}`} className={`item ${selected === r.id ? 'on' : ''}`} style={{ position: 'absolute', top, left: 0, right: 0, paddingLeft: 10 + r.depth * 14 + (r.crumb === undefined ? 16 : 0) }} onClick={() => onOpen(r.id)} title={`${r.method} ${r.path}${r.crumb ? `\n${r.crumb}` : ''}`}>
                <Method m={r.method} />
                <span className="name">{hl(r.name)}</span>
                {r.crumb !== undefined && <span className="muted small name" style={{ marginLeft: 'auto', maxWidth: '45%' }}>{hl(r.path)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
