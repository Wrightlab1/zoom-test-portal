import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNow } from '../hooks';

// ------------------------------------------------------------------ formatting
export const fmtTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { hour12: false }) : '—');
export const fmtTimeShort = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const t = d.toLocaleTimeString(undefined, { hour12: false });
  return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
};
export const fmtMs = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
export const fmtBytes = (n: number | null | undefined) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export function fmtDuration(ms: number): string {
  const neg = ms < 0;
  let s = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const out = h ? `${h}h ${m}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  return neg ? `-${out}` : out;
}
export const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;

// ------------------------------------------------------------------ toasts
interface ToastMsg {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ copy / secrets
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = 'Copy', className = 'sm', getText }: { text?: string; label?: string; className?: string; getText?: () => Promise<string> }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          const t = getText ? await getText() : (text ?? '');
          await copyText(t);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      }}
    >
      {done ? '✓ Copied' : label}
    </button>
  );
}

export function CopyLine({ value, label }: { value: string; label?: string }) {
  return (
    <div className="copyline">
      {label && <span className="muted small" style={{ minWidth: 110 }}>{label}</span>}
      <code title={value}>{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

/** A masked secret with deliberate reveal and copy actions. `fetchValue` hits the reveal endpoint. */
export function Secret({ hint, fetchValue }: { hint: string | null; fetchValue: () => Promise<string> }) {
  const [value, setValue] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), 60_000); // auto re-mask
    return () => clearTimeout(t);
  }, [value]);
  if (!hint) return <span className="muted">—</span>;
  return (
    <div className="secret">
      <span className={`val ${value ? 'revealed' : ''}`}>{value ?? hint}</span>
      <button
        type="button"
        className="sm"
        onClick={async () => {
          if (value) return setValue(null);
          try {
            setValue(await fetchValue());
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e), 'error');
          }
        }}
      >
        {value ? 'Hide' : 'Reveal'}
      </button>
      <CopyButton getText={async () => value ?? (await fetchValue())} />
    </div>
  );
}

// ------------------------------------------------------------------ small pieces
export function Method({ m }: { m: string }) {
  return <span className={`method ${m}`}>{m}</span>;
}

export function StatusCode({ status, error }: { status: number | null | undefined; error?: string | null }) {
  if (status == null) return <span className="status err" title={error ?? ''}>ERR</span>;
  return <span className={`status s${Math.floor(status / 100)}`}>{status}</span>;
}

export function Countdown({ to }: { to: number | null }) {
  const now = useNow(1000);
  if (!to) return <span className="muted">—</span>;
  const left = to - now;
  const cls = left <= 0 ? 'bad' : left < 5 * 60_000 ? 'warn' : 'good';
  return <span className={`badge ${cls}`}>{left <= 0 ? `expired ${fmtDuration(-left)} ago` : `expires in ${fmtDuration(left)}`}</span>;
}

export function Spinner() {
  return <span className="spin" aria-label="Loading" />;
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="banner error">
      <span className="icon">✕</span>
      <span>{error}</span>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number | null }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="count"> {t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header>
          <div className="grow" style={{ minWidth: 0 }}>{title}</div>
          {actions}
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <header>
          <h2 className="grow" style={{ margin: 0 }}>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ key/value editor
export interface KVRow {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}
export function KeyValueEditor({ rows, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value' }: { rows: KVRow[]; onChange: (r: KVRow[]) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  const set = (i: number, patch: Partial<KVRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const all = [...rows, { key: '', value: '', enabled: true }];
  return (
    <div className="kvedit">
      {all.map((r, i) => {
        const isNew = i === rows.length;
        return (
          <div key={i} style={{ display: 'contents' }}>
            <input type="checkbox" checked={r.enabled} disabled={isNew} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label="Enabled" />
            <input
              type="text"
              placeholder={keyPlaceholder}
              value={r.key}
              onChange={(e) => (isNew ? onChange([...rows, { key: e.target.value, value: '', enabled: true }]) : set(i, { key: e.target.value }))}
            />
            <input
              type="text"
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => (isNew ? onChange([...rows, { key: '', value: e.target.value, enabled: true }]) : set(i, { value: e.target.value }))}
            />
            {isNew ? <span /> : <button className="ghost icon sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">✕</button>}
            {r.description && <div className="desc">{r.description}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ JSON viewer
function JsonNode({ k, v, depth, defaultOpen }: { k?: string | number; v: unknown; depth: number; defaultOpen: number }) {
  const [open, setOpen] = useState(depth < defaultOpen);
  const keyEl = k !== undefined ? <><span className="k">{typeof k === 'number' ? k : JSON.stringify(k)}</span>: </> : null;
  if (v === null) return <div>{keyEl}<span className="z">null</span></div>;
  if (typeof v === 'string') return <div>{keyEl}<span className="s">{JSON.stringify(v)}</span></div>;
  if (typeof v === 'number') return <div>{keyEl}<span className="n">{v}</span></div>;
  if (typeof v === 'boolean') return <div>{keyEl}<span className="b">{String(v)}</span></div>;
  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [i, x] as const) : Object.entries(v as Record<string, unknown>);
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <div>{keyEl}{o}{c}</div>;
  return (
    <div>
      <span className="tog" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</span>
      {keyEl}
      {o}
      {open ? (
        <>
          <div className="ind">
            {entries.map(([ck, cv]) => (
              <JsonNode key={String(ck)} k={ck} v={cv} depth={depth + 1} defaultOpen={defaultOpen} />
            ))}
          </div>
          {c}
        </>
      ) : (
        <span className="sum" onClick={() => setOpen(true)}> {entries.length} {isArr ? 'items' : 'keys'} {c}</span>
      )}
    </div>
  );
}

export function JsonView({ value, defaultOpen = 3 }: { value: unknown; defaultOpen?: number }) {
  const [key, setKey] = useState(0);
  const [depth, setDepth] = useState(defaultOpen);
  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="sm ghost" onClick={() => { setDepth(99); setKey(key + 1); }}>Expand all</button>
        <button className="sm ghost" onClick={() => { setDepth(1); setKey(key + 1); }}>Collapse</button>
      </div>
      <div className="json" key={key}>
        <JsonNode v={value} depth={0} defaultOpen={depth} />
      </div>
    </div>
  );
}

/** Body viewer: collapsible JSON when it parses, raw text otherwise, with copy. */
export function BodyView({ body, contentType, emptyText = 'No body' }: { body: string | null | undefined; contentType?: string | null; emptyText?: string }) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    if (!body) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }, [body]);
  if (!body) return <div className="muted small">{emptyText}</div>;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row">
        {parsed !== undefined && (
          <div className="seg">
            <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>Formatted</button>
            <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>Raw</button>
          </div>
        )}
        <span className="muted small">{contentType}</span>
        <span className="right" />
        <CopyButton text={body} />
      </div>
      {parsed !== undefined && !raw ? <JsonView value={parsed} /> : <pre className="code">{body}</pre>}
    </div>
  );
}

export function HeadersTable({ headers, highlight = [] }: { headers: Record<string, string>; highlight?: string[] }) {
  const entries = Object.entries(headers);
  if (!entries.length) return <div className="muted small">None</div>;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={highlight.some((h) => k.toLowerCase().includes(h)) ? { color: 'var(--accent)', fontWeight: 600 } : undefined}>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}
