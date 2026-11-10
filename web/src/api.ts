/** Admin API client: same-origin, session cookie, CSRF header on state-changing requests. */
let csrf: string | null = null;
export const setCsrf = (t: string | null) => {
  csrf = t;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
export const onUnauthenticated = (fn: Listener) => {
  unauthListeners.add(fn);
  return () => {
    unauthListeners.delete(fn);
  };
};

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'unauthenticated') unauthListeners.forEach((f) => f());
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? data?.error ?? `HTTP ${res.status}`, data);
  }
  if (data && typeof data === 'object' && typeof data.csrf === 'string') csrf = data.csrf;
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export function qs(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
