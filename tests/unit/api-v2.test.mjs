import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';

function fakeFetch(routes, seen = []) {
  return async (url, init) => {
    const u = new URL(url);
    seen.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const hit = routes[`${init.method} ${u.pathname}`];
    if (!hit) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(hit.status === 204 ? null : JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

test('client sends the directory header, unwraps data and refuses the SPA', async () => {
  const seen = [];
  const client = createClient({ baseUrl: 'http://x', password: 'pw', directory: '/w', fetchImpl: fakeFetch({ 'GET /api/info': { body: { version: '2.0.22' } }, 'GET /api/agent': { body: { data: [{ id: 'build' }] } } }, seen) });
  const api = createApi(client);
  assert.deepEqual((await api.agents()).map((agent) => [agent.name, agent.native]), [['build', true]]);
  assert.equal(seen[0].headers['x-opencode-directory'], '/w');
  assert.equal((await api.info()).version, '2.0.22');
  await assert.rejects(client.get('/global/health'), { code: 'NOT_JSON' });
});

test('createSession refuses a body without explicit permissions and model', async () => {
  const api = createApi(createClient({ baseUrl: 'http://x', password: 'pw', fetchImpl: fakeFetch({}) }));
  await assert.rejects(api.createSession({ title: 'OPC: t' }), { code: 'UNSAFE_SESSION' });
  await assert.rejects(api.createSession({ title: 'OPC: t', permissions: [], model: { providerID: 'p', id: 'm' } }), { code: 'UNSAFE_SESSION' });
  await assert.rejects(api.createSession({ title: 'OPC: t', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), { code: 'UNSAFE_SESSION' });
});

test('permission replies go to the session route with a decision', async () => {
  const seen = [];
  const api = createApi(createClient({ baseUrl: 'http://x', password: 'pw', fetchImpl: fakeFetch({ 'POST /api/session/ses_a/permission/per_b/reply': { status: 204 } }, seen) }));
  await api.replyPermission('ses_a', 'per_b', { reply: 'reject', message: 'no' });
  assert.deepEqual(seen[0].body, { decision: 'reject', message: 'no' });
  await assert.rejects(api.replyPermission('ses_a', 'per_b', { reply: 'always' }), { code: 'INVALID_REPLY' });
});
