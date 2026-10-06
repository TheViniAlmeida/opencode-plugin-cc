import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { ConnectionError, NotFoundError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const PASSWORD = 'http-test-password-0123456789';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), directory: req.headers['x-opencode-directory'], auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    handler(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('sends Basic auth, directory header and JSON bodies; parses JSON and 204', async (t) => {
  const srv = await startServer(t, (req, res, url) => {
    if (url.pathname === '/api/empty') { res.writeHead(204); res.end(); return; }
    json(res, 200, { ok: true, method: req.method });
  });
  const client = createClient({ baseUrl: `${srv.url}/`, password: PASSWORD, directory: '/tmp/my ws' });
  assert.deepEqual(await client.get('/api/info'), { ok: true, method: 'GET' });
  assert.deepEqual(await client.post('/api/x', { a: 1 }), { ok: true, method: 'POST' });
  assert.deepEqual(await client.patch('/api/x', { b: 2 }, { query: { limit: 5 } }), { ok: true, method: 'PATCH' });
  assert.equal(await client.get('/api/empty'), null);
  const expectedAuth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  assert.equal(srv.seen[0].auth, expectedAuth);
  assert.equal(srv.seen[0].directory, '/tmp/my ws');
  assert.deepEqual(srv.seen[0].query, {});
  assert.equal(srv.seen[1].body, '{"a":1}');
  assert.equal(srv.seen[2].directory, '/tmp/my ws');
  assert.deepEqual(srv.seen[2].query, { limit: '5' });
  assert.equal(client.baseUrl, srv.url);
  assert.equal(client.directory, '/tmp/my ws');
  assert.equal(client.buildUrl('/api/event'), `${srv.url}/api/event`);
  assert.deepEqual(client.authHeaders(), { authorization: expectedAuth });
});

test('maps 401, 404, 400 and 5xx to typed errors with redacted bodies', async (t) => {
  const srv = await startServer(t, (req, res, url) => {
    const status = Number(url.pathname.slice(1));
    json(res, status, { name: 'BadRequest', data: { apiKey: 'sk-should-not-leak', message: 'bad' } });
  });
  const client = createClient({ baseUrl: srv.url, password: PASSWORD });
  await assert.rejects(client.get('/401'), (e) => e instanceof ConnectionError && e.code === 'AUTH_FAILED' && e.exitCode === 5);
  await assert.rejects(client.get('/404'), (e) => e instanceof NotFoundError);
  await assert.rejects(client.post('/400', {}), (e) => {
    assert.ok(e instanceof RequestError);
    assert.equal(e.code, 'BAD_REQUEST');
    assert.equal(e.details.body.data.apiKey, '***');
    assert.ok(!e.message.includes('sk-should-not-leak'));
    return true;
  });
  await assert.rejects(client.get('/503'), (e) => e instanceof RequestError && e.code === 'SERVER_ERROR');
  assert.equal(srv.seen.filter((r) => r.path === '/401').length, 1, 'AUTH_FAILED is never retried');
});

test('error messages never contain the password or the query string', async (t) => {
  const srv = await startServer(t, (req, res) => json(res, 500, { echo: req.headers.authorization, pw: PASSWORD }));
  const client = createClient({ baseUrl: srv.url, password: PASSWORD, directory: '/secret/dir' });
  await assert.rejects(client.get('/api/x'), (e) => {
    assert.ok(!e.message.includes(PASSWORD));
    assert.ok(!e.message.includes('/secret/dir'));
    assert.ok(!JSON.stringify(e.details).includes(PASSWORD));
    return true;
  });
});

test('timeouts become ConnectionError TIMEOUT', async (t) => {
  const srv = await startServer(t, () => {});
  const client = createClient({ baseUrl: srv.url, requestTimeoutMs: 5000 });
  await assert.rejects(client.get('/hang', { timeoutMs: 150, retryOnServerDown: false }), (e) => e.code === 'TIMEOUT' && e.exitCode === 5);
});

test('connection refused becomes SERVER_DOWN; GET retries once through onServerDown', async (t) => {
  const deadUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startServer(t, (req, res) => json(res, 200, { auth: req.headers.authorization }));
  let calls = 0;
  const client = createClient({
    baseUrl: deadUrl,
    password: 'old-password-123456',
    onServerDown: async () => {
      calls += 1;
      return { url: srv.url, password: 'new-password-654321' };
    },
  });
  const body = await client.get('/api/info');
  assert.equal(calls, 1);
  assert.equal(body.auth, `Basic ${Buffer.from('opencode:new-password-654321').toString('base64')}`);
  assert.equal(client.baseUrl, srv.url);
});

test('POST does not retry on SERVER_DOWN unless retryOnServerDown is set', async (t) => {
  const deadUrl = `http://127.0.0.1:${await freePort()}`;
  const srv = await startServer(t, (req, res) => json(res, 200, { ok: true }));
  let calls = 0;
  const onServerDown = async () => { calls += 1; return srv.url; };
  const client = createClient({ baseUrl: deadUrl, onServerDown });
  await assert.rejects(client.post('/api/x', {}), (e) => e.code === 'SERVER_DOWN');
  assert.equal(calls, 0);
  const client2 = createClient({ baseUrl: deadUrl, onServerDown });
  assert.deepEqual(await client2.post('/x', {}, { retryOnServerDown: true }), { ok: true });
  assert.equal(calls, 1);
});
