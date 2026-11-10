import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Fetch with loading/error state; `reload()` re-runs it. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => {
        if (my === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => my === seq.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => my === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []), setData };
}

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onopen = () => {
    connected = true;
    statusListeners.forEach((f) => f(true));
  };
  source.onerror = () => {
    connected = false;
    statusListeners.forEach((f) => f(false));
  };
  for (const name of ['webhook', 'token', 'tunnel', 'call']) {
    source.addEventListener(name, (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      handlers.get(name)?.forEach((h) => h(d));
    });
  }
}
export function closeStream() {
  source?.close();
  source = null;
}

/** Subscribe to a live server event (SSE). */
export function useLive(name: 'webhook' | 'token' | 'tunnel' | 'call', fn: Handler) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensureSource();
    const h: Handler = (d) => ref.current(d);
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(h);
    return () => {
      handlers.get(name)!.delete(h);
    };
  }, [name]);
}

export function useLiveStatus() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    statusListeners.add(setC);
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useHashRoute(): [string, URLSearchParams, (path: string, params?: Record<string, string>) => void] {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '') || '/profiles';
    const [p, q] = h.split('?');
    return [p, new URLSearchParams(q ?? '')] as const;
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav = useCallback((path: string, params?: Record<string, string>) => {
    const q = params ? new URLSearchParams(params).toString() : '';
    window.location.hash = path + (q ? `?${q}` : '');
  }, []);
  return [state[0], state[1], nav];
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [v, set];
}
