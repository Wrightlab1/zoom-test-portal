import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, qs } from '../api';
import { errMsg, useAsync, useLive, useLocalState } from '../hooks';
import { BodyView, CopyButton, Drawer, ErrorBanner, HeadersTable, Method, Spinner, StatusCode, Tabs, copyText, fmtBytes, fmtMs, fmtTime, fmtTimeShort, pct, useToast } from '../components/ui';
import { HBars, Meter, StackedBars } from '../components/charts';
import { DebouncedInput, ExportButtons, MultiSelect, Pager, RangePicker, SavedFilters, SortHeader, resolveRange, useProfilesMap, type RangeState } from './reportCommon';
import { RateLimitBadges, ResponsePanel } from './Explorer';

interface Filters {
  q: string;
  rangeState: RangeState;
  profileId: string[];
  method: string[];
  statusClass: string[];
  status: string;
  endpoint: string;
  category: 'api' | 'token' | 'all';
  sort: string;
  dir: 'asc' | 'desc';
  pageSize: number;
}
const DEFAULTS: Filters = { q: '', rangeState: { range: '7d' }, profileId: [], method: [], statusClass: [], status: '', endpoint: '', category: 'api', sort: 'ts', dir: 'desc', pageSize: 50 };

const RL_CATEGORIES = ['Light', 'Medium', 'Heavy', 'Resource-intensive'];

export function CallsPage({ params }: { params: URLSearchParams }) {
  const [f, setF] = useLocalState<Filters>('ztp.calls.filters', DEFAULTS);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(Number(params.get('open')) || null);
  const profiles = useProfilesMap();
  useEffect(() => {
    if (params.get('category')) setF({ ...f, category: params.get('category') as Filters['category'] });
    if (params.get('open')) setOpenId(Number(params.get('open')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('open'), params.get('category')]);

  const set = (patch: Partial<Filters>) => {
    setF({ ...f, ...patch });
    setPage(1);
  };
  const { from, to } = resolveRange(f.rangeState);
  const filterQuery = qs({ tz: -new Date().getTimezoneOffset(), q: f.q, from, to, profileId: f.profileId, method: f.method, statusClass: f.statusClass, status: f.status.replace(/\s/g, ''), endpoint: f.endpoint, category: f.category, sort: f.sort, dir: f.dir });
  const list = useAsync<any>(() => get(`/api/reports/calls${filterQuery}&page=${page}&pageSize=${f.pageSize}`), [filterQuery, page, f.pageSize]);
  const summary = useAsync<any>(() => get(`/api/reports/calls/summary${filterQuery}`), [filterQuery]);

  // Live: refresh when new calls arrive and the newest are on screen.
  const pending = useRef<number>(undefined);
  useLive('call', (c) => {
    if (f.category !== 'all' && c.category !== f.category) return;
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      if (page === 1 && f.sort === 'ts' && f.dir === 'desc') list.reload();
      summary.reload();
    }, 600);
  });

  const onSort = (col: string) => set({ sort: col, dir: f.sort === col && f.dir === 'desc' ? 'asc' : 'desc' });
  const s = summary.data;
  const rlByCategory = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of s?.rateLimits ?? []) if (!m.has(r.category) && r.type !== 'Daily-limit') m.set(r.category, r);
    return m;
  }, [s]);
  const active = f.q || f.profileId.length || f.method.length || f.statusClass.length || f.status || f.endpoint;

  return (
    <div className="page">
      <div className="page-head">
        <h1>API calls</h1>
        <div className="seg">
          {(['api', 'token', 'all'] as const).map((c) => <button key={c} className={f.category === c ? 'on' : ''} onClick={() => set({ category: c })}>{c === 'api' ? 'API' : c === 'token' ? 'Token endpoint' : 'All'}</button>)}
        </div>
        <span className="grow" />
        <SavedFilters view="calls" current={f} onApply={(nf) => set({ ...DEFAULTS, ...nf })} />
        <ExportButtons base="/api/reports/calls/export" query={filterQuery} />
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <DebouncedInput value={f.q} onChange={(q) => set({ q })} placeholder="Search URLs, headers, bodies, tracking IDs…" style={{ width: 300 }} type="search" />
        <RangePicker value={f.rangeState} onChange={(rangeState) => set({ rangeState })} />
        <MultiSelect label="profiles" options={[...profiles.values()].map((p) => ({ value: String(p.id), label: p.name }))} value={f.profileId} onChange={(profileId) => set({ profileId })} />
        <MultiSelect label="methods" options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m }))} value={f.method} onChange={(method) => set({ method })} />
        <MultiSelect label="statuses" options={['2xx', '3xx', '4xx', '5xx', 'error'].map((v) => ({ value: v, label: v === 'error' ? 'transport error' : v }))} value={f.statusClass} onChange={(statusClass) => set({ statusClass })} />
        <DebouncedInput value={f.status} onChange={(status) => set({ status })} placeholder="Exact status e.g. 401,429" style={{ width: 160 }} className="mono" />
        <DebouncedInput value={f.endpoint} onChange={(endpoint) => set({ endpoint })} placeholder="Endpoint contains…" style={{ width: 180 }} className="mono" />
        {active ? <button className="sm ghost" onClick={() => set({ ...DEFAULTS, rangeState: f.rangeState, category: f.category })}>Clear filters</button> : null}
      </div>

      {/* ---------- summary ---------- */}
      <div className="grid4" style={{ marginBottom: 12 }}>
        <div className="card stat"><span className="l">Total calls</span><span className="v">{s ? s.total.toLocaleString() : '—'}</span><span className="muted small">{s?.retries ? `${s.retries} automatic retr${s.retries === 1 ? 'y' : 'ies'} after 401` : ' '}</span></div>
        <div className="card stat"><span className="l">Failures (4xx/5xx/transport)</span><span className="v" style={{ color: s?.failures ? 'var(--critical-text)' : undefined }}>{s ? s.failures.toLocaleString() : '—'}</span><span className="muted small">{s ? `${pct(s.errorRate)} error rate` : ''}</span></div>
        <div className="card stat"><span className="l">Latency p50 / p95 / p99</span><span className="v" style={{ fontSize: 18 }}>{s?.latency?.p50 != null ? `${fmtMs(s.latency.p50)} · ${fmtMs(s.latency.p95)} · ${fmtMs(s.latency.p99)}` : '—'}</span><span className="muted small">{s?.latency?.avg != null ? `avg ${fmtMs(s.latency.avg)}, max ${fmtMs(s.latency.max)}` : ''}</span></div>
        <div className="card">
          <h3>Rate limit usage (latest headers)</h3>
          <div className="col" style={{ gap: 6 }}>
            {RL_CATEGORIES.map((c) => {
              const r = rlByCategory.get(c);
              return (
                <div key={c} className="row nowrap small" title={r ? `Last seen ${fmtTime(r.ts)} — X-RateLimit-Remaining ${r.remaining} of ${r.limit} (${r.type}). Shared by all apps on the account.` : 'No calls in this category yet'}>
                  <span style={{ width: 120 }}>{c}</span>
                  <div className="grow">{r?.limit ? <Meter used={r.limit - r.remaining} limit={r.limit} /> : <div className="meter" />}</div>
                  <span className="num muted" style={{ width: 64, textAlign: 'right' }}>{r?.limit ? `${r.remaining}/${r.limit}` : '—'}</span>
                </div>
              );
            })}
            {(s?.rateLimits ?? []).filter((r: any) => r.type === 'Daily-limit').slice(0, 2).map((r: any) => (
              <div key={`d${r.category}`} className="small muted">Daily limit ({r.category}): {r.remaining}/{r.limit} left</div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-charts" style={{ marginBottom: 12 }}>
        <div className="card">
          <h3>Calls vs failures {s?.series ? `per ${s.series.bucket}` : ''}</h3>
          {s ? <StackedBars points={s.series.points} bucket={s.series.bucket} bucketMs={s.series.bucketMs} offsetMs={s.series.offsetMs} from={from} to={to ?? Date.now()} okLabel="Successful" failLabel="Failed" /> : <Spinner />}
        </div>
        <div className="card">
          <h3>Failures by status</h3>
          <HBars
            color="var(--critical)"
            rows={(s?.failuresByStatus ?? []).map((x: any) => ({ key: String(x.status ?? 'error'), label: <><StatusCode status={x.status} /> <span className="muted small">{x.message ?? ''}</span></>, value: x.count, title: x.message ?? '' }))}
            onClick={(k) => (k === 'error' ? set({ statusClass: ['error'] }) : set({ status: k }))}
          />
        </div>
        <div className="card">
          <h3>Top endpoints</h3>
          <HBars rows={(s?.byEndpoint ?? []).slice(0, 8).map((x: any) => ({ key: `${x.method} ${x.endpoint}`, label: <><Method m={x.method} /><span className="mono small">{x.endpoint}</span></>, value: x.count, title: `${x.failures} failed · avg ${fmtMs(x.avgMs)}` }))} onClick={(k) => set({ endpoint: k.split(' ').slice(1).join(' ') })} />
        </div>
      </div>

      {/* ---------- table ---------- */}
      <div className="card flush">
        <ErrorBanner error={list.error} />
        <div style={{ overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <SortHeader col="ts" label="Time" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="profile_id" label="Profile" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="method" label="Method" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="url" label="Endpoint" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="status" label="Status" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="duration_ms" label="Duration" {...{ sort: f.sort, dir: f.dir, onSort }} className="nowrap" />
                <SortHeader col="rl_remaining" label="Rate limit" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="tracking_id" label="Tracking ID" {...{ sort: f.sort, dir: f.dir, onSort }} />
              </tr>
            </thead>
            <tbody>
              {list.data?.rows.map((r: any) => (
                <tr key={r.id} className={`clickable ${openId === r.id ? 'selected' : ''}`} onClick={() => setOpenId(r.id)}>
                  <td className="nowrap">{fmtTimeShort(r.ts)}</td>
                  <td className="nowrap">{profiles.get(r.profile_id)?.name ?? <span className="muted">#{r.profile_id ?? '—'}</span>}{r.category === 'token' && <span className="badge" style={{ marginLeft: 4 }}>{r.grant_type}</span>}</td>
                  <td><Method m={r.method} /></td>
                  <td className="url" style={{ maxWidth: 520 }}>
                    {r.url}
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      {r.endpoint && r.endpoint !== r.url && <span className="muted small">{r.endpoint}</span>}
                      {r.attempt > 1 && <span className="badge info">retry of #{r.retry_of}</span>}
                      {r.replay_of && <span className="badge">re-run of #{r.replay_of}</span>}
                    </div>
                  </td>
                  <td className="nowrap"><StatusCode status={r.status} error={r.error} />{r.zoom_error_code && <span className="muted small"> · {r.zoom_error_code}</span>}{r.error && !r.status && <div className="small" style={{ color: 'var(--critical-text)', maxWidth: 220 }}>{r.error}</div>}</td>
                  <td className="num nowrap">{fmtMs(r.duration_ms)}</td>
                  <td className="nowrap small">{r.rl_limit != null ? <span title={`${r.rl_category} · ${r.rl_type}`}>{r.rl_remaining}/{r.rl_limit} <span className="muted">{r.rl_category}</span></span> : <span className="muted">—</span>}</td>
                  <td className="mono small" style={{ maxWidth: 220, wordBreak: 'break-all' }}>{r.tracking_id ?? ''}</td>
                </tr>
              ))}
              {list.data?.rows.length === 0 && <tr><td colSpan={8} className="empty">No calls match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {list.data && <Pager page={page} pageSize={f.pageSize} total={list.data.total} onPage={setPage} onPageSize={(pageSize) => set({ pageSize })} />}
      </div>
      {openId && <CallDrawer id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} profiles={profiles} />}
    </div>
  );
}

function CallDrawer({ id, onClose, onOpen, profiles }: { id: number; onClose: () => void; onOpen: (id: number) => void; profiles: Map<number, any> }) {
  const toast = useToast();
  const c = useAsync<any>(() => get(`/api/calls/${id}`), [id]);
  const [tab, setTab] = useState<'response' | 'request' | 'meta'>('response');
  const [rerun, setRerun] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const d = c.data;
  return (
    <Drawer
      title={d ? <div className="row nowrap"><StatusCode status={d.status} error={d.error} /><Method m={d.method} /><span className="mono small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.endpoint ?? d.url}</span><span className="muted small">#{d.id}</span></div> : 'Loading…'}
      onClose={onClose}
      actions={d && d.category === 'api' && (
        <>
          <button className="sm" disabled={busy} onClick={async () => { setBusy(true); try { setRerun(await post(`/api/calls/${id}/replay`)); toast('Re-run complete'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }}>{busy ? <Spinner /> : null} Re-run</button>
          <a className="btn sm" href={`#/explorer?call=${id}`}>Open in explorer</a>
          <button className="sm" onClick={async () => { await copyText((await get(`/api/calls/${id}/curl`)).curl); toast('curl copied (token as $ZOOM_ACCESS_TOKEN)'); }}>Copy curl</button>
          <button className="sm ghost" onClick={async () => { if (!confirm('Copy curl with the current live access token for this authorization?')) return; try { await copyText((await get(`/api/calls/${id}/curl?reveal=1`)).curl); toast('curl copied with token'); } catch (e) { toast(errMsg(e), 'error'); } }}>+token</button>
        </>
      )}
    >
      {c.loading && !d && <Spinner />}
      <ErrorBanner error={c.error} />
      {d && (
        <div className="col">
          <div className="row">
            <span className="badge">{fmtTime(d.ts)}</span>
            <span className="badge">{fmtMs(d.durationMs)}</span>
            <span className="badge">{fmtBytes(d.responseSize)}</span>
            <span className="badge">{profiles.get(d.profileId)?.name ?? `profile #${d.profileId}`}</span>
            <span className="badge">{d.category === 'token' ? `token · ${d.grantType}` : d.authType}</span>
            <RateLimitBadges rl={d.rateLimit} />
          </div>
          {d.trackingId && <div className="row nowrap small"><span className="muted">Tracking ID</span><code>{d.trackingId}</code><CopyButton text={d.trackingId} /></div>}
          {d.zoomErrorCode && <div className="banner error"><span className="icon">✕</span><span>Zoom error <b className="mono">{d.zoomErrorCode}</b>: {d.zoomErrorMessage}</span></div>}
          {d.error && <ErrorBanner error={d.error} />}
          {d.related?.length > 1 && (
            <div className="row small">
              <span className="muted">Related:</span>
              {d.related.map((r: any) => <button key={r.id} className={`sm ${r.id === d.id ? 'primary' : ''}`} onClick={() => onOpen(r.id)}>#{r.id} {r.retryOf ? `retry` : r.replayOf ? 're-run' : 'attempt ' + r.attempt} · {r.status ?? 'ERR'}</button>)}
            </div>
          )}
          <div className="mono small" style={{ wordBreak: 'break-all' }}>{d.url}</div>
          <Tabs tabs={[{ id: 'response', label: 'Response' }, { id: 'request', label: 'Request' }, { id: 'meta', label: 'Details' }]} value={tab} onChange={setTab} />
          {tab === 'response' && (
            <div className="col">
              <h3>Headers</h3>
              <HeadersTable headers={d.responseHeaders} highlight={['ratelimit', 'trackingid', 'retry-after']} />
              <h3>Body {d.responseTruncated && <span className="badge warn">truncated</span>}</h3>
              <BodyView body={d.responseBody} contentType={d.responseContentType} />
            </div>
          )}
          {tab === 'request' && (
            <div className="col">
              <h3>Headers (as sent, redacted)</h3>
              <HeadersTable headers={d.requestHeaders} />
              {d.query && (<><h3>Query</h3><pre className="code">{decodeURIComponent(d.query.replace(/&/g, '\n').replace(/\+/g, ' '))}</pre></>)}
              <h3>Body</h3>
              <BodyView body={d.requestBody} emptyText="No request body" />
            </div>
          )}
          {tab === 'meta' && (
            <dl className="kv">
              {Object.entries({ id: d.id, category: d.category, profile: d.profileId, authorization: d.authorizationId, 'auth type': d.authType, 'grant type': d.grantType, endpoint: d.endpoint, host: d.host, path: d.path, 'collection request': d.collectionRequestId, 'saved request': d.savedRequestId, attempt: d.attempt, 'retry of': d.retryOf, 're-run of': d.replayOf, 'content type': d.responseContentType, 'X-RateLimit-Category': d.rateLimit.category, 'X-RateLimit-Type': d.rateLimit.type, 'X-RateLimit-Limit': d.rateLimit.limit, 'X-RateLimit-Remaining': d.rateLimit.remaining, 'X-RateLimit-Reset': d.rateLimit.reset, 'Retry-After': d.rateLimit.retryAfter, redirects: d.redirects?.length ? d.redirects.map((r: any) => `${r.status} → ${r.location}`).join('\n') : null }).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v == null || v === '' ? '—' : String(v)}</dd></div>
              ))}
            </dl>
          )}
          {rerun && (
            <div style={{ marginTop: 12 }}>
              <h3>Re-run result</h3>
              {rerun.warnings?.map((w: string, i: number) => <div key={i} className="banner warn"><span className="icon">!</span>{w}</div>)}
              <ResponsePanel calls={rerun.calls} />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
