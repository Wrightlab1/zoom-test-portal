import { useMemo, useRef, useState } from 'react';

/**
 * Small hand-rolled SVG charts. Colors: successful = categorical slot 1 (blue), failed = status
 * critical (red). Identity never relies on color alone: there is always a legend and a tooltip.
 */

export interface SeriesPoint {
  t: number;
  ok: number;
  failed: number;
}

function niceMax(v: number) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const fmtBucket = (t: number, bucket: string) => {
  const d = new Date(t);
  if (bucket === 'minute' || bucket === 'hour') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Stacked bars over time: successful (bottom) and failed (top), 2px surface gap between segments. */
export function StackedBars({ points, bucket, bucketMs, offsetMs = 0, from, to, okLabel = 'Successful', failLabel = 'Failed', height = 170 }: { points: SeriesPoint[]; bucket: string; bucketMs: number; offsetMs?: number; from?: number; to?: number; okLabel?: string; failLabel?: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // Fill empty buckets so time reads evenly.
  const filled = useMemo(() => {
    if (!points.length) return [];
    const align = (t: number) => Math.floor((t + offsetMs) / bucketMs) * bucketMs - offsetMs;
    const start = from != null ? align(from) : points[0].t;
    const end = to != null ? align(to) : points[points.length - 1].t;
    const byT = new Map(points.map((p) => [p.t, p]));
    const out: SeriesPoint[] = [];
    if ((end - start) / bucketMs > 400) return points; // too many to fill; plot what we have
    for (let t = start; t <= end; t += bucketMs) out.push(byT.get(t) ?? { t, ok: 0, failed: 0 });
    return out;
  }, [points, bucketMs, offsetMs, from, to]);

  const W = 600;
  const H = height;
  const padL = 34;
  const padB = 20;
  const padT = 6;
  const max = niceMax(Math.max(1, ...filled.map((p) => p.ok + p.failed)));
  const n = Math.max(1, filled.length);
  const slot = (W - padL) / n;
  const bw = Math.max(1, Math.min(28, slot * 0.7));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  if (!filled.length) return <div className="empty small">No data in this range</div>;
  return (
    <div className="chart" ref={ref}>
      <div className="legend">
        <span><i style={{ background: 'var(--series-ok)' }} />{okLabel}</span>
        <span><i style={{ background: 'var(--critical)' }} />{failLabel}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${okLabel} and ${failLabel} per ${bucket}`} onMouseLeave={() => setHover(null)}>
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={padL} x2={W} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        {ticks.map((t) => (
          <text key={t} x={padL - 6} y={y(t) + 3} textAnchor="end">{Math.round(t)}</text>
        ))}
        <line className="axis" x1={padL} x2={W} y1={y(0)} y2={y(0)} />
        {filled.map((p, i) => {
          const cx = padL + slot * i + slot / 2;
          const okTop = y(p.ok);
          const total = y(p.ok + p.failed);
          const gap = p.ok > 0 && p.failed > 0 ? 2 : 0;
          return (
            <g key={p.t}>
              {p.ok > 0 && <rect x={cx - bw / 2} y={okTop} width={bw} height={y(0) - okTop} fill="var(--series-ok)" rx={p.failed ? 0 : Math.min(4, bw / 2)} />}
              {p.failed > 0 && <rect x={cx - bw / 2} y={total} width={bw} height={Math.max(1, okTop - total - gap)} fill="var(--critical)" rx={Math.min(4, bw / 2)} />}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 5} textAnchor="middle">{fmtBucket(p.t, bucket)}</text>
              )}
              {/* hit target larger than the mark */}
              <rect
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={H - padT - padB}
                fill="transparent"
                onMouseEnter={() => {
                  const box = ref.current?.getBoundingClientRect();
                  const svgW = box?.width ?? W;
                  setHover({ i, x: (cx / W) * svgW, y: (total / H) * ((svgW / W) * H) + 22 });
                }}
              />
            </g>
          );
        })}
      </svg>
      {hover && filled[hover.i] && (
        <div className="tip" style={{ left: hover.x, top: hover.y }}>
          <div className="muted">{new Date(filled[hover.i].t).toLocaleString(undefined, { hour12: false })}</div>
          <div><i style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--series-ok)', borderRadius: 2, marginRight: 6 }} />{okLabel}: <b className="num">{filled[hover.i].ok}</b></div>
          <div><i style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--critical)', borderRadius: 2, marginRight: 6 }} />{failLabel}: <b className="num">{filled[hover.i].failed}</b></div>
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for a ranked breakdown (single series: no legend; the card title names it). */
export function HBars({ rows, color = 'var(--series-ok)', onClick }: { rows: { label: React.ReactNode; value: number; title?: string; key: string }[]; color?: string; onClick?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="muted small">None</div>;
  return (
    <div className="hbar">
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'contents', cursor: onClick ? 'pointer' : undefined }} onClick={() => onClick?.(r.key)} title={r.title}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.label}</div>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
          <div className="num" style={{ textAlign: 'right' }}>{r.value.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

/** Usage meter for rate-limit headers: used = limit − remaining. */
export function Meter({ used, limit }: { used: number; limit: number }) {
  const f = limit ? Math.min(1, Math.max(0, used / limit)) : 0;
  const color = f >= 0.9 ? 'var(--critical)' : f >= 0.7 ? 'var(--warn)' : 'var(--series-ok)';
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
      <div style={{ width: `${f * 100}%`, background: color }} />
    </div>
  );
}
