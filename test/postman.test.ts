import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseCollection, parseEnvironment, resolveVars, fillPathVariables, encodePathValue, PostmanError } from '../server/lib/postman.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/zoom-collection.sample.json', import.meta.url), 'utf8'));

describe('Postman collection parser', () => {
  const c = parseCollection(fixture);

  it('reads collection metadata and variables', () => {
    expect(c.name).toBe('Zoom Meeting API (sample fixture)');
    expect(c.postmanId).toBe('00000000-1111-2222-3333-444444444444');
    expect(c.variables.find((v) => v.key === 'baseUrl')?.value).toBe('https://api.zoom.us/v2');
    expect(c.authType).toBe('bearer');
  });

  it('builds nested folders with stable keys', () => {
    expect(c.folders.map((f) => f.key)).toEqual(['Meetings', 'Meetings/Meetings', 'Meetings/Cloud Recording', 'Users']);
    expect(c.folders[1].parentKey).toBe('Meetings');
    expect(c.folders[0].description).toBe('Meeting APIs');
  });

  it('parses methods, URL templates, path variables and query params', () => {
    const list = c.requests.find((r) => r.name === 'List meetings')!;
    expect(list.method).toBe('GET');
    expect(list.folderKey).toBe('Meetings/Meetings');
    expect(list.matchKey).toBe('GET /users/:userId/meetings');
    expect(list.definition.pathTemplate).toBe('/users/:userId/meetings');
    expect(list.definition.host).toBe('{{baseUrl}}');
    expect(list.definition.pathVariables).toEqual([{ key: 'userId', value: 'me', description: expect.stringContaining('pass the `me` value') }]);
    expect(list.definition.query.map((q) => [q.key, !!q.disabled])).toEqual([
      ['type', false],
      ['page_size', false],
      ['next_page_token', true],
      ['page_number', true],
    ]);
    expect(list.description).toContain('Rate Limit Label');
  });

  it('parses saved example responses', () => {
    const ex = c.requests.find((r) => r.name === 'List meetings')!.definition.examples;
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ code: 200, status: 'OK', language: 'json' });
    expect(JSON.parse(ex[0].body!).meetings[0].id).toBe(85746065432);
    expect(ex[1].code).toBe(404);
  });

  it('parses raw JSON, urlencoded bodies and description objects', () => {
    const create = c.requests.find((r) => r.name === 'Create a meeting')!;
    expect(create.definition.body.mode).toBe('raw');
    expect(create.definition.body.language).toBe('json');
    expect(JSON.parse(create.definition.body.raw!).topic).toBe('My Meeting');
    expect(create.description).toBe('Create a meeting for a user.');
    const form = c.requests.find((r) => r.name === 'Update user (form)')!;
    expect(form.definition.body.urlencoded).toEqual([{ key: 'first_name', value: 'Ada' }, { key: 'last_name', value: '', disabled: true }]);
  });

  it('handles string URLs, raw header blocks, inherited auth and missing variables', () => {
    const rtms = c.requests.find((r) => r.name.startsWith('Update participant'))!;
    expect(rtms.definition.pathTemplate).toBe('/live_meetings/:meetingId/rtms_app/status');
    expect(rtms.definition.pathVariables.map((v) => v.key)).toEqual(['meetingId']);
    const users = c.requests.find((r) => r.name === 'List users')!;
    expect(users.definition.headers).toEqual([{ key: 'Accept', value: 'application/json' }, { key: 'X-Fixture', value: 'yes' }]);
    const del = c.requests.find((r) => r.name === 'Delete meeting recordings')!;
    expect(del.definition.authType).toBe('oauth2');
    expect(del.definition.pathVariables).toEqual([{ key: 'meetingId', value: '' }]);
  });

  it('disambiguates duplicate method+path entries and warns on broken items', () => {
    const keys = c.requests.map((r) => r.matchKey);
    expect(keys).toContain('GET /users');
    expect(keys).toContain('GET /users #2');
    expect(new Set(keys).size).toBe(keys.length);
    expect(c.warnings.some((w) => w.includes('Broken item'))).toBe(true);
    expect(c.requests).toHaveLength(9);
  });

  it('rejects non-collections', () => {
    expect(() => parseCollection({ foo: 1 })).toThrow(PostmanError);
    expect(() => parseCollection(null)).toThrow(PostmanError);
  });

  it('accepts the Postman API wrapper shape {collection: {...}}', () => {
    expect(parseCollection({ collection: fixture }).requests).toHaveLength(9);
  });

  it('parses a large collection quickly', () => {
    const big = { info: { name: 'big', schema: 'v2.1.0' }, item: Array.from({ length: 40 }, (_, f) => ({ name: `F${f}`, item: Array.from({ length: 25 }, (_, i) => ({ name: `R${i}`, request: { method: 'GET', url: `{{baseUrl}}/f${f}/r${i}/:id` }, response: [{ code: 200, body: '{"x":1}' }] })) })) };
    const t = performance.now();
    const p = parseCollection(big);
    expect(p.requests).toHaveLength(1000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('environments and variables', () => {
  const env = parseEnvironment(JSON.parse(fs.readFileSync(new URL('./fixtures/zoom-environment.sample.json', import.meta.url), 'utf8')));

  it('parses environment values including disabled/secret flags', () => {
    expect(env.name).toBe('Zoom sample env');
    expect(env.values.find((v) => v.key === 'bearerToken')?.type).toBe('secret');
    expect(env.values.find((v) => v.key === 'unused')?.disabled).toBe(true);
  });

  it('resolves {{variables}} and reports unresolved ones', () => {
    const missing = new Set<string>();
    expect(resolveVars('{{baseUrl}}/users/{{ who }}?x={{nope}}', { baseUrl: 'https://api.zoom.us/v2', who: 'me' }, missing)).toBe('https://api.zoom.us/v2/users/me?x={{nope}}');
    expect([...missing]).toEqual(['nope']);
    expect(resolveVars('{{$timestamp}}', {})).toMatch(/^\d{10}$/);
  });

  it('fills path variables, double-encoding UUIDs that need it', () => {
    expect(fillPathVariables('https://api.zoom.us/v2/past_meetings/:meetingId', { meetingId: '/abc+def//ghi==' })).toBe('https://api.zoom.us/v2/past_meetings/%252Fabc%252Bdef%252F%252Fghi%253D%253D');
    expect(fillPathVariables('https://api.zoom.us/v2/past_meetings/:meetingId', { meetingId: 'abc+def==' })).toBe('https://api.zoom.us/v2/past_meetings/abc%2Bdef%3D%3D');
    expect(fillPathVariables('http://127.0.0.1:4900/v2/users/:userId/meetings', { userId: 'me' })).toBe('http://127.0.0.1:4900/v2/users/me/meetings');
    const missing = new Set<string>();
    expect(fillPathVariables('/meetings/:meetingId', {}, {}, missing)).toBe('/meetings/:meetingId');
    expect([...missing]).toEqual(['meetingId']);
    expect(encodePathValue('abc', 'double')).toBe('abc');
    expect(encodePathValue('a/b', 'single')).toBe('a%2Fb');
  });
});
