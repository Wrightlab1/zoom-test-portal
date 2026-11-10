import { useMemo, useRef, useState } from 'react';
import { get, qs } from '../api';
import { useAsync, useLive, useLocalState } from '../hooks';
import { BodyView, CopyButton, Drawer, ErrorBanner, HeadersTable, JsonView, Spinner, Tabs, fmtMs, fmtTime, fmtTimeShort, pct } from '../components/ui';
import { HBars, StackedBars } from '../components/charts';
import { DebouncedInput, ExportButtons, MultiSelect, Pager, RangePicker, SavedFilters, SortHeader, resolveRange, useProfilesMap, type RangeState } from './reportCommon';

interface Filters {
  q: string;
  rangeState: RangeState;
  profileId: string[];
  event: string[];
  eventResource: string[];
  signature: string[];
  responseStatus: string;
  validation: 'all' | 'only' | 'exclude';
  duplicates: 'all' | 'only' | 'exclude';
  sort: string;
  dir: 'asc' | 'desc';
  pageSize: number;
}
const DEFAULTS: Filters = { q: '', rangeState: { range: '7d' }, profileId: [], event: [], eventResource: [], signature: [], responseStatus: '', validation: 'all', duplicates: 'all', sort: 'received_at', dir: 'desc', pageSize: 50 };

export const SIGNATURE_INFO: Record<string, { label: string; cls: string; explain: string }> = {
  valid: { label: 'Verified', cls: 'good', explain: 'x-zm-signature matched the HMAC of the raw body with this profile’s secret token, within the replay window.' },
  invalid: { label: 'Bad signature', cls: 'bad', explain: 'The signature did not match: wrong secret token, or the body was altered in transit.' },
  missing: { label: 'Unsigned', cls: 'bad', explain: 'x-zm-signature or x-zm-request-timestamp was missing.' },
  stale: { label: 'Stale', cls: 'warn', explain: 'Signature matched but the timestamp is outside the replay tolerance (Settings).' },
  no_secret: { label: 'No secret set', cls: 'warn', explain: 'The profile has no webhook secret token, so the request could not be verified.' },
  unknown_profile: { label: 'Unknown path', cls: 'bad', explain: 'No profile matches this webhook path.' },
  not_post: { label: 'Not POST', cls: 'warn', explain: 'Zoom only sends POST; this request used another method.' },
};

export function SignatureBadge({ s }: { s: string }) {
  const i = SIGNATURE_INFO[s] ?? { label: s, cls: '', explain: '' };
  return <span className={`badge ${i.cls}`} title={i.explain}>{i.cls === 'good' ? '✓' : i.cls === 'bad' ? '✕' : '!'} {i.label}</span>;
}

const resourceOf = (e: string | null) => (e ? e.split('.')[0] : '—');

export function WebhooksPage() {
  const [f, setF] = useLocalState<Filters>('ztp.webhooks.filters', DEFAULTS);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [paused, setPaused] = useState(false);
  const profiles = useProfilesMap();
  const set = (patch: Partial<Filters>) => {
    setF({ ...f, ...patch });
    setPage(1);
  };
  const { from, to } = resolveRange(f.rangeState);
  const filterQuery = qs({ tz: -new Date().getTimezoneOffset(), q: f.q, from, profileId: f.profileId, event: f.event, eventResource: f.eventResource, signature: f.signature, responseStatus: f.responseStatus.replace(/\s/g, ''), validation: f.validation, duplicates: f.duplicates, sort: f.sort, dir: f.dir, to });
  const list = useAsync<any>(() => get(`/api/reports/webhooks${filterQuery}&page=${page}&pageSize=${f.pageSize}`), [filterQuery, page, f.pageSize]);
  const summary = useAsync<any>(() => get(`/api/reports/webhooks/summary${filterQuery}`), [filterQuery]);

  const t = useRef<number>(undefined);
  useLive('webhook', (w) => {
    if (paused) return;
    setFlash((s) => new Set(s).add(w.id));
    setTimeout(() => setFlash((s) => { const n = new Set(s); n.delete(w.id); return n; }), 1800);
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => {
      if (page === 1 && f.sort === 'received_at' && f.dir === 'desc') list.reload();
      summary.reload();
    }, 250);
  });
  const onSort = (col: string) => set({ sort: col, dir: f.sort === col && f.dir === 'desc' ? 'asc' : 'desc' });
  const s = summary.data;
  const resources = useMemo(() => [...new Set<string>((s?.eventNames ?? []).map(resourceOf))].sort(), [s]);
  const live = page === 1 && f.sort === 'received_at' && f.dir === 'desc' && !paused;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Webhooks</h1>
        <span className={`badge ${live ? 'good' : ''}`}>{live ? '● Live' : paused ? 'Paused' : 'Live updates on page 1, newest first'}</span>
        <button className="sm ghost" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        <span className="grow" />
        <SavedFilters view="webhooks" current={f} onApply={(nf) => set({ ...DEFAULTS, ...nf })} />
        <ExportButtons base="/api/reports/webhooks/export" query={filterQuery} />
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <DebouncedInput value={f.q} onChange={(q) => set({ q })} placeholder="Search event, headers, body…" style={{ width: 260 }} type="search" />
        <RangePicker value={f.rangeState} onChange={(rangeState) => set({ rangeState })} />
        <MultiSelect label="profiles" options={[...profiles.values()].map((p) => ({ value: String(p.id), label: p.name }))} value={f.profileId} onChange={(profileId) => set({ profileId })} />
        <MultiSelect label="resources" options={resources.filter((r) => r !== '—').map((r) => ({ value: r }))} value={f.eventResource} onChange={(eventResource) => set({ eventResource })} />
        <MultiSelect label="events" options={(s?.eventNames ?? []).map((e: string) => ({ value: e }))} value={f.event} onChange={(event) => set({ event })} />
        <MultiSelect label="signatures" options={Object.entries(SIGNATURE_INFO).map(([k, v]) => ({ value: k, label: v.label }))} value={f.signature} onChange={(signature) => set({ signature })} />
        <DebouncedInput value={f.responseStatus} onChange={(responseStatus) => set({ responseStatus })} placeholder="We returned e.g. 401" style={{ width: 150 }} className="mono" />
        <select value={f.duplicates} onChange={(e) => set({ duplicates: e.target.value as any })} aria-label="Duplicates"><option value="all">Duplicates: show</option><option value="only">Duplicates only</option><option value="exclude">Hide duplicates</option></select>
        <select value={f.validation} onChange={(e) => set({ validation: e.target.value as any })} aria-label="URL validation"><option value="all">Validations: show</option><option value="only">Validations only</option><option value="exclude">Hide validations</option></select>
      </div>

      <div className="grid4" style={{ marginBottom: 12 }}>
        <div className="card stat"><span className="l">Received</span><span className="v">{s ? s.total.toLocaleString() : '—'}</span><span className="muted small">{s ? `${s.validations} URL validation${s.validations === 1 ? '' : 's'}` : ''}</span></div>
        <div className="card stat"><span className="l">Rejected (signature / replay / path)</span><span className="v" style={{ color: s?.rejected ? 'var(--critical-text)' : undefined }}>{s ? s.rejected.toLocaleString() : '—'}</span><span className="muted small">{s ? `${pct(s.errorRate)} answered non-2xx` : ''}</span></div>
        <div className="card stat"><span className="l">Duplicate deliveries (retries)</span><span className="v">{s ? s.duplicates.toLocaleString() : '—'}</span><span className="muted small">at-least-once delivery, flagged not hidden</span></div>
        <div className="card stat"><span className="l">Our handling time p50 / p99</span><span className="v" style={{ fontSize: 18 }}>{s?.handleMs?.p50 != null ? `${fmtMs(s.handleMs.p50)} · ${fmtMs(s.handleMs.p99)}` : '—'}</span><span className="muted small">time to answer Zoom</span></div>
      </div>
      <div className="grid-charts" style={{ marginBottom: 12 }}>
        <div className="card"><h3>Deliveries {s?.series ? `per ${s.series.bucket}` : ''}</h3>{s ? <StackedBars points={s.series.points} bucket={s.series.bucket} bucketMs={s.series.bucketMs} offsetMs={s.series.offsetMs} from={from} to={to ?? Date.now()} okLabel="Answered 2xx" failLabel="Rejected (4xx)" /> : <Spinner />}</div>
        <div className="card"><h3>By event</h3><HBars rows={(s?.byEvent ?? []).slice(0, 8).map((x: any) => ({ key: x.key ?? '(none)', label: <span className="mono small">{x.key ?? '(unparsed)'}</span>, value: x.count, title: `${x.rejected} rejected` }))} onClick={(k) => k !== '(none)' && set({ event: [k] })} /></div>
        <div className="card"><h3>By verification result</h3><HBars rows={(s?.bySignature ?? []).map((x: any) => ({ key: x.key, label: <SignatureBadge s={x.key} />, value: x.count }))} color="var(--text-3)" onClick={(k) => set({ signature: [k] })} /></div>
      </div>

      <div className="card flush">
        <ErrorBanner error={list.error} />
        <div style={{ overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <SortHeader col="event" label="Event name" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <th>Resource</th>
                <SortHeader col="received_at" label="Received" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="profile_id" label="Profile" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="signature" label="Verification" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <SortHeader col="response_status" label="We returned" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <th>Flags</th>
                <SortHeader col="account_id" label="Account" {...{ sort: f.sort, dir: f.dir, onSort }} />
                <th>Tracking ID</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.rows.map((r: any) => (
                <tr key={r.id} className={`clickable ${openId === r.id ? 'selected' : ''} ${flash.has(r.id) ? 'flash' : ''}`} onClick={() => setOpenId(r.id)}>
                  <td className="mono">{r.event ?? <span className="muted">(no event)</span>}</td>
                  <td>{resourceOf(r.event)}</td>
                  <td className="nowrap">{fmtTimeShort(r.received_at)}</td>
                  <td className="nowrap">{profiles.get(r.profile_id)?.name ?? <span className="muted">{r.slug ?? r.path}</span>}</td>
                  <td><SignatureBadge s={r.signature} /></td>
                  <td><span className={`status s${Math.floor(r.response_status / 100)}`}>{r.response_status}</span></td>
                  <td className="nowrap">
                    {r.is_validation ? <span className="badge info">URL validation</span> : null}
                    {r.duplicate_of ? <span className="badge warn" title={r.duplicate_kind === 'identical_body' ? 'Byte-identical body to an earlier delivery (retry)' : 'Same event name + event_ts as an earlier delivery'}>dup of #{r.duplicate_of}</span> : null}
                    {r.error && r.signature === 'valid' ? <span className="badge bad" title={r.error}>error</span> : null}
                  </td>
                  <td className="mono small">{r.account_id ?? ''}</td>
                  <td className="mono small" style={{ maxWidth: 260, wordBreak: 'break-all' }}>{r.tracking_id ?? ''}</td>
                </tr>
              ))}
              {list.data?.rows.length === 0 && <tr><td colSpan={9} className="empty">No webhooks yet. Point a Zoom event subscription at a profile’s webhook URL, or run <code>npm run mock:webhook -- --suite …</code>.</td></tr>}
            </tbody>
          </table>
        </div>
        {list.data && <Pager page={page} pageSize={f.pageSize} total={list.data.total} onPage={setPage} onPageSize={(pageSize) => set({ pageSize })} />}
      </div>
      {openId && <WebhookDrawer id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} profiles={profiles} />}
    </div>
  );
}

function WebhookDrawer({ id, onClose, onOpen, profiles }: { id: number; onClose: () => void; onOpen: (id: number) => void; profiles: Map<number, any> }) {
  const w = useAsync<any>(() => get(`/api/webhooks/${id}`), [id]);
  const [tab, setTab] = useState<'payload' | 'raw' | 'headers' | 'response'>('payload');
  const d = w.data;
  return (
    <Drawer title={d ? <div className="row nowrap"><span className="mono">{d.event ?? '(no event)'}</span><SignatureBadge s={d.signature} /><span className="muted small">#{d.id}</span></div> : 'Loading…'} onClose={onClose}>
      {w.loading && !d && <Spinner />}
      <ErrorBanner error={w.error} />
      {d && (
        <div className="col">
          <div className={`banner ${SIGNATURE_INFO[d.signature]?.cls === 'good' ? 'info' : SIGNATURE_INFO[d.signature]?.cls === 'warn' ? 'warn' : 'error'}`}>
            <span className="icon">{d.signature === 'valid' ? '✓' : '!'}</span>
            <div>
              <b>{SIGNATURE_INFO[d.signature]?.label ?? d.signature}</b> — {SIGNATURE_INFO[d.signature]?.explain}
              {d.error && <div className="small" style={{ marginTop: 2 }}>{d.error}</div>}
              <div className="small" style={{ marginTop: 2 }}>The portal answered <b className="mono">{d.responseStatus}</b> in {fmtMs(d.handleMs)}.</div>
            </div>
          </div>
          <dl className="kv">
            <dt>Received</dt><dd>{fmtTime(d.receivedAt)}</dd>
            <dt>Profile</dt><dd>{profiles.get(d.profileId)?.name ?? '—'} ({d.path})</dd>
            <dt>event_ts</dt><dd>{d.eventTs ? `${d.eventTs} (${fmtTime(d.eventTs)})` : '—'}</dd>
            <dt>x-zm-request-timestamp</dt><dd>{d.requestTs ? `${d.requestTs}${/^\d+$/.test(d.requestTs) ? ` (${fmtTime(Number(d.requestTs) * (Number(d.requestTs) > 1e12 ? 1 : 1000))})` : ''}` : '—'}</dd>
            <dt>Account</dt><dd>{d.accountId ?? '—'}</dd>
            <dt>Tracking ID</dt><dd>{d.trackingId ? <span className="row nowrap">{d.trackingId}<CopyButton text={d.trackingId} /></span> : '—'}</dd>
            <dt>Remote IP</dt><dd>{d.remoteIp ?? '—'}</dd>
            <dt>Body</dt><dd>{d.bodySize} bytes · sha256 {d.bodyHash?.slice(0, 16)}…</dd>
          </dl>
          {d.deliveries?.length > 1 && (
            <div className="row small">
              <span className="muted">Deliveries of this event:</span>
              {d.deliveries.map((x: any) => <button key={x.id} className={`sm ${x.id === d.id ? 'primary' : ''}`} onClick={() => onOpen(x.id)}>#{x.id} · {fmtTimeShort(x.receivedAt)} · {x.responseStatus}{x.duplicateKind ? ` · ${x.duplicateKind === 'identical_body' ? 'retry' : 'same event_ts'}` : ''}</button>)}
            </div>
          )}
          <Tabs tabs={[{ id: 'payload', label: 'Parsed payload' }, { id: 'raw', label: 'Raw body (exact bytes)' }, { id: 'headers', label: 'Headers', count: Object.keys(d.requestHeaders ?? {}).length }, { id: 'response', label: 'Our response' }]} value={tab} onChange={setTab} />
          {tab === 'payload' && (d.payload ? <JsonView value={d.payload} /> : <div className="muted small">Body was not a JSON object.</div>)}
          {tab === 'raw' && (
            <div className="col">
              {d.rawRedacted && <div className="banner warn"><span className="icon">!</span><span>The raw body contained one of the portal’s own secrets and was redacted before storage.</span></div>}
              {d.rawBodyBase64 ? <><div className="muted small">Body is not valid UTF-8; showing base64.</div><pre className="code">{d.rawBodyBase64}</pre></> : <div className="col" style={{ gap: 4 }}><div className="row"><span className="grow" /><CopyButton text={d.rawBody ?? ''} /></div><pre className="code">{d.rawBody ?? '(empty)'}</pre></div>}
            </div>
          )}
          {tab === 'headers' && <HeadersTable headers={d.requestHeaders} highlight={['x-zm-']} />}
          {tab === 'response' && <BodyView body={d.responseBody} emptyText="(empty body)" />}
        </div>
      )}
    </Drawer>
  );
}
