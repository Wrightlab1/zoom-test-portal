import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { del, get, post, qs } from '../api';
import { errMsg, useAsync } from '../hooks';
import { Modal, Field, useToast } from '../components/ui';

export const RANGES = [
  { id: '1h', label: 'Last hour', ms: 3600_000 },
  { id: '24h', label: 'Last 24 hours', ms: 86400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86400_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86400_000 },
  { id: 'all', label: 'All time', ms: 0 },
  { id: 'custom', label: 'Custom…', ms: 0 },
] as const;

export interface RangeState {
  range: string;
  from?: number;
  to?: number;
}

export function resolveRange(r: RangeState): { from?: number; to?: number } {
  if (r.range === 'custom') return { from: r.from, to: r.to };
  const def = RANGES.find((x) => x.id === r.range);
  if (!def || !def.ms) return {};
  return { from: Date.now() - def.ms };
}

const toLocalInput = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export function RangePicker({ value, onChange }: { value: RangeState; onChange: (r: RangeState) => void }) {
  return (
    <div className="row nowrap">
      <select value={value.range} onChange={(e) => onChange({ range: e.target.value, from: value.from ?? Date.now() - 86400_000, to: value.to })} aria-label="Date range">
        {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      {value.range === 'custom' && (
        <>
          <input type="datetime-local" value={toLocalInput(value.from)} onChange={(e) => onChange({ ...value, from: e.target.value ? new Date(e.target.value).getTime() : undefined })} aria-label="From" />
          <span className="muted">→</span>
          <input type="datetime-local" value={toLocalInput(value.to)} onChange={(e) => onChange({ ...value, to: e.target.value ? new Date(e.target.value).getTime() : undefined })} aria-label="To" />
        </>
      )}
    </div>
  );
}

/** Text input that only commits after the user pauses typing. */
export function DebouncedInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const t = useRef<number>(undefined);
  return (
    <input
      {...rest}
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        window.clearTimeout(t.current);
        const nv = e.target.value;
        t.current = window.setTimeout(() => onChange(nv), 300);
      }}
    />
  );
}

/** Multi-select as a compact dropdown of checkboxes. */
export function MultiSelect({ label, options, value, onChange }: { label: string; options: { value: string; label?: ReactNode }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  const text = value.length === 0 ? `All ${label}` : value.length <= 2 ? value.join(', ') : `${value.length} ${label}`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(!open)} className={value.length ? 'on' : ''} style={value.length ? { borderColor: 'var(--accent)' } : undefined}>{text} ▾</button>
      {open && (
        <div className="card" style={{ position: 'absolute', top: 32, left: 0, zIndex: 20, minWidth: 200, maxHeight: 320, overflow: 'auto', boxShadow: 'var(--shadow)', padding: 6 }}>
          {value.length > 0 && <button className="sm ghost" onClick={() => onChange([])} style={{ marginBottom: 4 }}>Clear</button>}
          {options.map((o) => (
            <label key={o.value} className="check" style={{ display: 'flex', padding: '3px 4px' }}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
              {o.label ?? o.value}
            </label>
          ))}
          {!options.length && <div className="muted small">No values yet</div>}
        </div>
      )}
    </div>
  );
}

export function SavedFilters<F extends object>({ view, current, onApply }: { view: 'calls' | 'webhooks'; current: F; onApply: (f: F) => void }) {
  const toast = useToast();
  const list = useAsync<any[]>(() => get(`/api/saved-filters${qs({ view })}`), [view]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <select
        value=""
        onChange={async (e) => {
          const v = e.target.value;
          if (v === '__save') return setNaming(true);
          if (v.startsWith('del:')) {
            const id = Number(v.slice(4));
            if (confirm('Delete this saved filter?')) {
              await del(`/api/saved-filters/${id}`);
              list.reload();
            }
            return;
          }
          const f = list.data?.find((x) => String(x.id) === v);
          if (f) onApply(f.filter);
        }}
        aria-label="Saved filters"
      >
        <option value="">Saved filters…</option>
        {list.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        <option value="__save">+ Save current filters…</option>
        {list.data?.length ? <optgroup label="Delete">{list.data.map((f) => <option key={`d${f.id}`} value={`del:${f.id}`}>✕ {f.name}</option>)}</optgroup> : null}
      </select>
      {naming && (
        <Modal title="Save filter set" onClose={() => setNaming(false)} footer={<><button onClick={() => setNaming(false)}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={async () => { try { await post('/api/saved-filters', { view, name, filter: current }); setNaming(false); setName(''); list.reload(); toast('Filter saved'); } catch (e) { toast(errMsg(e), 'error'); } }}>Save</button></>}>
          <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}

export function SortHeader({ col, label, sort, dir, onSort, className }: { col: string; label: ReactNode; sort: string; dir: 'asc' | 'desc'; onSort: (col: string) => void; className?: string }) {
  return (
    <th className={`sortable ${className ?? ''}`} onClick={() => onSort(col)} aria-sort={sort === col ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label} {sort === col ? (dir === 'asc' ? '▲' : '▼') : <span className="muted">↕</span>}
    </th>
  );
}

export function Pager({ page, pageSize, total, onPage, onPageSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span className="num">{total.toLocaleString()} rows</span>
      <span className="grow" />
      <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page">
        {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
      </select>
      <button className="sm" disabled={page <= 1} onClick={() => onPage(1)}>«</button>
      <button className="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
      <span className="num">Page {page.toLocaleString()} of {pages.toLocaleString()}</span>
      <button className="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button>
      <button className="sm" disabled={page >= pages} onClick={() => onPage(pages)}>»</button>
    </div>
  );
}

export function useProfilesMap() {
  const p = useAsync<any[]>(() => get('/api/profiles'), []);
  return useMemo(() => new Map<number, any>((p.data ?? []).map((x) => [x.id, x])), [p.data]);
}

export function ExportButtons({ base, query }: { base: string; query: string }) {
  return (
    <div className="row nowrap" style={{ gap: 2 }}>
      <a className="btn" href={`${base}${query}${query ? '&' : '?'}format=csv`} download>Export CSV</a>
      <a className="btn" href={`${base}${query}${query ? '&' : '?'}format=json`} download>JSON</a>
    </div>
  );
}
