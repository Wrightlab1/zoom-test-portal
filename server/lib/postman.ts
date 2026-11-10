/**
 * Postman Collection v2.1 (and v2.0) parser, plus environment files and {{variable}} resolution.
 * Pure functions — no I/O — so it can be unit-tested against fixtures.
 */

export interface KV {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
  type?: string;
}

export interface ParsedBody {
  mode: 'none' | 'raw' | 'urlencoded' | 'formdata' | 'graphql' | 'file';
  raw?: string;
  language?: string;
  urlencoded?: KV[];
  formdata?: KV[];
  graphql?: { query?: string; variables?: string };
}

export interface ParsedExample {
  name: string;
  status: string | null;
  code: number | null;
  headers: KV[];
  body: string | null;
  language: string | null;
}

export interface RequestDefinition {
  urlRaw: string;
  host: string;
  pathTemplate: string;
  pathVariables: KV[];
  query: KV[];
  headers: KV[];
  body: ParsedBody;
  authType: string | null;
  examples: ParsedExample[];
}

export interface ParsedFolder {
  key: string;
  parentKey: string | null;
  name: string;
  description: string | null;
  sort: number;
}

export interface ParsedRequest {
  matchKey: string;
  postmanId: string | null;
  name: string;
  folderKey: string | null;
  method: string;
  description: string | null;
  definition: RequestDefinition;
  sort: number;
}

export interface ParsedCollection {
  name: string;
  postmanId: string | null;
  description: string | null;
  schema: string | null;
  variables: KV[];
  authType: string | null;
  folders: ParsedFolder[];
  requests: ParsedRequest[];
  warnings: string[];
}

export class PostmanError extends Error {}

type Json = any;

const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

export function description(d: unknown): string | null {
  if (d == null) return null;
  if (typeof d === 'string') return d || null;
  if (typeof d === 'object' && 'content' in (d as Json)) return str((d as Json).content) || null;
  return null;
}

function kvList(list: unknown): KV[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object' && (x as Json).key != null)
    .map((x: Json) => ({
      key: str(x.key),
      value: str(x.value ?? x.src ?? ''),
      ...(description(x.description) ? { description: description(x.description)! } : {}),
      ...(x.disabled ? { disabled: true } : {}),
      ...(x.type ? { type: str(x.type) } : {}),
    }));
}

function headerList(h: unknown): KV[] {
  if (typeof h === 'string') {
    // v2.0 allowed a raw header block
    return h
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      });
  }
  return kvList(h);
}

/** Split a raw URL string like "{{baseUrl}}/users/:userId?status=active" into parts. */
function parseRawUrl(raw: string) {
  const [beforeHash] = raw.split('#');
  const qi = beforeHash.indexOf('?');
  const base = qi >= 0 ? beforeHash.slice(0, qi) : beforeHash;
  const qs = qi >= 0 ? beforeHash.slice(qi + 1) : '';
  let host = '';
  let path = base;
  const scheme = /^([a-z]+:\/\/)?([^/]*)(\/.*)?$/i.exec(base);
  if (scheme) {
    host = (scheme[1] ?? '') + (scheme[2] ?? '');
    path = scheme[3] ?? '';
  }
  const query: KV[] = qs
    ? qs.split('&').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return i >= 0 ? { key: p.slice(0, i), value: p.slice(i + 1) } : { key: p, value: '' };
      })
    : [];
  return { host, path, query };
}

function parseUrl(u: unknown): { raw: string; host: string; pathTemplate: string; pathVariables: KV[]; query: KV[] } {
  if (typeof u === 'string') {
    const p = parseRawUrl(u);
    const vars = [...p.path.matchAll(/(?:^|\/):([A-Za-z_][\w.-]*)/g)].map((m) => ({ key: m[1], value: '' }));
    return { raw: u, host: p.host, pathTemplate: p.path || '/', pathVariables: vars, query: p.query };
  }
  if (!u || typeof u !== 'object') return { raw: '', host: '', pathTemplate: '/', pathVariables: [], query: [] };
  const o = u as Json;
  const raw = str(o.raw);
  const fromRaw = raw ? parseRawUrl(raw) : null;
  const host = Array.isArray(o.host) ? o.host.map(str).join('.') : o.host != null ? str(o.host) : (fromRaw?.host ?? '');
  const protocol = o.protocol ? `${str(o.protocol)}://` : '';
  let pathTemplate: string;
  if (Array.isArray(o.path)) pathTemplate = '/' + o.path.map((s: unknown) => (typeof s === 'object' && s ? str((s as Json).value) : str(s))).join('/');
  else if (typeof o.path === 'string') pathTemplate = o.path.startsWith('/') ? o.path : '/' + o.path;
  else pathTemplate = fromRaw?.path || '/';
  const declared = kvList(o.variable);
  // Make sure every :segment has an entry, even if the export omitted it.
  for (const m of pathTemplate.matchAll(/(?:^|\/):([A-Za-z_][\w.-]*)/g)) {
    if (!declared.some((d) => d.key === m[1])) declared.push({ key: m[1], value: '' });
  }
  const query = o.query !== undefined ? kvList(o.query) : (fromRaw?.query ?? []);
  return { raw: raw || `${protocol}${host}${pathTemplate}`, host: protocol + host, pathTemplate, pathVariables: declared, query };
}

function parseBody(b: unknown): ParsedBody {
  if (!b || typeof b !== 'object') return { mode: 'none' };
  const o = b as Json;
  if (o.disabled) return { mode: 'none' };
  switch (o.mode) {
    case 'raw':
      return { mode: 'raw', raw: str(o.raw), language: o.options?.raw?.language ?? undefined };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: kvList(o.urlencoded) };
    case 'formdata':
      return { mode: 'formdata', formdata: kvList(o.formdata) };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: str(o.graphql?.query), variables: str(o.graphql?.variables) } };
    case 'file':
      return { mode: 'file' };
    default:
      return { mode: 'none' };
  }
}

function parseExamples(list: unknown): ParsedExample[] {
  if (!Array.isArray(list)) return [];
  return list.map((r: Json) => {
    const headers = headerList(r.header);
    const ct = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
    return {
      name: str(r.name) || 'Example',
      status: r.status != null ? str(r.status) : null,
      code: typeof r.code === 'number' ? r.code : r.code != null && !isNaN(Number(r.code)) ? Number(r.code) : null,
      headers,
      body: r.body != null ? str(r.body) : null,
      language: r._postman_previewlanguage ?? (ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : null),
    };
  });
}

/** Strip a leading "{{baseUrl}}"-style host so templates read "/users/:userId". */
function normalizeTemplate(pathTemplate: string): string {
  const p = pathTemplate.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return p || '/';
}

export function parseCollection(input: unknown): ParsedCollection {
  if (!input || typeof input !== 'object') throw new PostmanError('Not a JSON object');
  const root = ('collection' in (input as Json) && (input as Json).collection?.info ? (input as Json).collection : input) as Json;
  if (!root.info || !Array.isArray(root.item)) throw new PostmanError('Not a Postman collection (expected "info" and "item")');
  const schema = str(root.info.schema);
  const warnings: string[] = [];
  if (schema && !/v2\.[01]/.test(schema)) warnings.push(`Unrecognized schema "${schema}"; parsed as v2.1.`);

  const folders: ParsedFolder[] = [];
  const requests: ParsedRequest[] = [];
  const seenKeys = new Map<string, number>();
  let sort = 0;

  const walk = (items: Json[], parentKey: string | null, inheritedAuth: string | null) => {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (Array.isArray(it.item)) {
        const base = `${parentKey ? parentKey + '/' : ''}${str(it.name) || 'Folder'}`;
        let key = base;
        for (let i = 2; folders.some((f) => f.key === key); i++) key = `${base} (${i})`;
        folders.push({ key, parentKey, name: str(it.name) || 'Folder', description: description(it.description), sort: sort++ });
        walk(it.item, key, it.auth?.type ?? inheritedAuth);
        continue;
      }
      if (!it.request) {
        warnings.push(`Skipped item "${str(it.name)}" with no request`);
        continue;
      }
      const req = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request;
      const method = (str(req.method) || 'GET').toUpperCase();
      const url = parseUrl(req.url);
      const pathTemplate = normalizeTemplate(url.pathTemplate);
      let matchKey = `${method} ${pathTemplate}`;
      const n = (seenKeys.get(matchKey) ?? 0) + 1;
      seenKeys.set(matchKey, n);
      if (n > 1) matchKey = `${matchKey} #${n}`;
      requests.push({
        matchKey,
        postmanId: it.id ? str(it.id) : it._postman_id ? str(it._postman_id) : null,
        name: str(it.name) || `${method} ${pathTemplate}`,
        folderKey: parentKey,
        method,
        description: description(req.description) ?? description(it.description),
        sort: sort++,
        definition: {
          urlRaw: url.raw,
          host: url.host,
          pathTemplate,
          pathVariables: url.pathVariables,
          query: url.query,
          headers: headerList(req.header),
          body: parseBody(req.body),
          authType: req.auth?.type ?? inheritedAuth,
          examples: parseExamples(it.response),
        },
      });
    }
  };
  walk(root.item, null, root.auth?.type ?? null);

  return {
    name: str(root.info.name) || 'Untitled collection',
    postmanId: root.info._postman_id ? str(root.info._postman_id) : null,
    description: description(root.info.description),
    schema: schema || null,
    variables: kvList(root.variable),
    authType: root.auth?.type ?? null,
    folders,
    requests,
    warnings,
  };
}

export interface ParsedEnvironment {
  name: string;
  postmanId: string | null;
  values: KV[];
}

export function parseEnvironment(input: unknown): ParsedEnvironment {
  if (!input || typeof input !== 'object') throw new PostmanError('Not a JSON object');
  const o = ('environment' in (input as Json) ? (input as Json).environment : input) as Json;
  if (!Array.isArray(o.values)) throw new PostmanError('Not a Postman environment (expected "values")');
  return {
    name: str(o.name) || 'Environment',
    postmanId: o.id ? str(o.id) : o._postman_id ? str(o._postman_id) : null,
    values: o.values
      .filter((v: Json) => v && v.key != null)
      .map((v: Json) => ({ key: str(v.key), value: str(v.value), ...(v.enabled === false ? { disabled: true } : {}), ...(v.type ? { type: str(v.type) } : {}) })),
  };
}

// ------------------------------------------------------------------ variables

const DYNAMIC: Record<string, () => string> = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

/** Replace {{name}} references. Unresolved names are left in place and reported. */
export function resolveVars(s: string, vars: Record<string, string>, unresolved?: Set<string>): string {
  return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (DYNAMIC[name]) return DYNAMIC[name]();
    unresolved?.add(name);
    return whole;
  });
}

/** Zoom rule: a UUID that begins with "/" or contains "//" must be double URL-encoded. */
export function needsDoubleEncoding(v: string): boolean {
  return v.startsWith('/') || v.includes('//');
}

export function encodePathValue(v: string, mode: 'auto' | 'single' | 'double' = 'auto'): string {
  const once = encodeURIComponent(v);
  return mode === 'double' || (mode === 'auto' && needsDoubleEncoding(v)) ? encodeURIComponent(once) : once;
}

/** Substitute ":name" path segments. */
export function fillPathVariables(path: string, values: Record<string, string>, modes: Record<string, 'auto' | 'single' | 'double'> = {}, missing?: Set<string>): string {
  return path.replace(/(^|\/):([A-Za-z_][\w.-]*)(?=\/|$|\?)/g, (whole, slash: string, name: string) => {
    const v = values[name];
    if (v == null || v === '') {
      missing?.add(name);
      return whole;
    }
    return slash + encodePathValue(v, modes[name] ?? 'auto');
  });
}
