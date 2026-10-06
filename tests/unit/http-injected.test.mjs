import assert from 'node:assert/strict';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { ConnectionError, NotFoundError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const PASSWORD = 'injected-http-password-012345';
const response = (status, body = null) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body === null ? '' : JSON.stringify(body),
});

test('auth, directory header, JSON request/response, and 204', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://opencode.test/', password: PASSWORD, directory: '/workspace here',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return calls.length === 4 ? response(204) : response(200, { ok: true });
    },
  });
  assert.deepEqual(await client.get('/api/info'), { ok: true });
  assert.deepEqual(await client.post('/api/items', { value: 1 }), { ok: true });
  await client.patch('/api/items/1', { value: 2 }, { query: { n: 5 } });
  assert.equal(await client.get('/api/empty'), null);
  assert.equal(calls[0].options.headers.authorization, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`);
  assert.equal(calls[0].options.headers['x-opencode-directory'], '/workspace here');
  assert.equal(calls[0].url.searchParams.get('directory'), null);
  assert.equal(calls[1].options.body, '{"value":1}');
  assert.equal(calls[2].options.headers['x-opencode-directory'], '/workspace here');
  assert.equal(calls[2].url.searchParams.get('n'), '5');
  assert.equal(client.baseUrl, 'http://opencode.test');
  assert.equal(client.directory, '/workspace here');
  assert.deepEqual(client.authHeaders(), calls[0].options.headers.authorization
    ? { authorization: calls[0].options.headers.authorization } : {});
});

test('maps status errors with redacted body and safe messages', async () => {
  const client = createClient({
    baseUrl: 'http://opencode.test', password: PASSWORD, directory: '/private/path',
    fetchImpl: async (url) => response(Number(new URL(url).pathname.slice(1)), {
      data: { apiKey: 'sk-do-not-leak', password: PASSWORD },
    }),
  });
  await assert.rejects(client.get('/401'), (err) => err instanceof ConnectionError && err.code === 'AUTH_FAILED' && err.exitCode === 5);
  await assert.rejects(client.get('/404'), (err) => err instanceof NotFoundError);
  await assert.rejects(client.post('/400', {}), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.code, 'BAD_REQUEST');
    assert.equal(err.details.body.data.apiKey, '***');
    assert.ok(!err.message.includes(PASSWORD));
    assert.ok(!JSON.stringify(err.details).includes(PASSWORD));
    return true;
  });
  await assert.rejects(client.get('/503'), (err) => err instanceof RequestError && err.code === 'SERVER_ERROR');
  await assert.rejects(client.get('/500?private=query-value'), (err) => {
    assert.ok(!err.message.includes('private=query-value'));
    assert.ok(!err.message.includes('/private/path'));
    return true;
  });
});

test('redacts base64 Basic credentials echoed in an HTTP error body', async () => {
  const password = 'auth-redaction-password-12345';
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const client = createClient({
    baseUrl: 'http://opencode.test', password,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => authorization }),
  });
  await assert.rejects(client.get('/api/echo'), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.code, 'SERVER_ERROR');
    assert.ok(!err.message.includes(authorization.slice(6)));
    assert.ok(!JSON.stringify(err.details).includes(authorization.slice(6)));
    assert.ok(!err.message.includes(password));
    assert.ok(!JSON.stringify(err.details).includes(password));
    return true;
  });
});

test('classifies arbitrary fetch exceptions as CLIENT_ERROR without recovery', async () => {
  let recoveryCalls = 0;
  const client = createClient({
    baseUrl: 'http://opencode.test',
    onServerDown: async () => { recoveryCalls += 1; return 'http://recovered.test'; },
    fetchImpl: async () => { throw new TypeError('boom'); },
  });
  await assert.rejects(client.get('/api/info'), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.code, 'CLIENT_ERROR');
    assert.equal(err.exitCode, 7);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  assert.equal(recoveryCalls, 0);
});

test('classifies nested connection causes as SERVER_DOWN and retries GET once', async () => {
  let attempt = 0;
  let recoveryCalls = 0;
  const client = createClient({
    baseUrl: 'http://down.test',
    onServerDown: async () => { recoveryCalls += 1; return 'http://up.test'; },
    fetchImpl: async (url) => {
      attempt += 1;
      if (new URL(url).host === 'down.test') {
        throw Object.assign(new Error('request failed', { cause: { code: 'ECONNREFUSED' } }));
      }
      return response(200, { ok: true });
    },
  });
  assert.deepEqual(await client.get('/api/info'), { ok: true });
  assert.equal(attempt, 2);
  assert.equal(recoveryCalls, 1);
});

test('timeout maps to TIMEOUT; GET retries once and POST retry is opt-in', async () => {
  const timeoutClient = createClient({
    baseUrl: 'http://opencode.test', requestTimeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(timeoutClient.get('/api/hang', { retryOnServerDown: false }), (err) => err.code === 'TIMEOUT' && err.exitCode === 5);

  let attempt = 0;
  let recoveryCalls = 0;
  const client = createClient({
    baseUrl: 'http://down.test', password: 'old-password-012345',
    onServerDown: async () => { recoveryCalls += 1; return { url: 'http://up.test', password: 'new-password-012345' }; },
    fetchImpl: async (url) => {
      attempt += 1;
      if (new URL(url).host === 'down.test') throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
      return response(200, { host: new URL(url).host });
    },
  });
  assert.deepEqual(await client.get('/api/info'), { host: 'up.test' });
  assert.equal(recoveryCalls, 1);
  assert.equal(attempt, 2);
  assert.equal(client.baseUrl, 'http://up.test');

  let postRecoveryCalls = 0;
  const postClient = createClient({
    baseUrl: 'http://down.test', onServerDown: async () => { postRecoveryCalls += 1; return 'http://up.test'; },
    fetchImpl: async (url) => {
      if (new URL(url).host === 'down.test') throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
      return response(200, { ok: true });
    },
  });
  await assert.rejects(postClient.post('/api/items', {}), (err) => err instanceof ConnectionError && err.code === 'SERVER_DOWN');
  assert.equal(postRecoveryCalls, 0);
  assert.deepEqual(await postClient.post('/api/items', {}, { retryOnServerDown: true }), { ok: true });
  assert.equal(postRecoveryCalls, 1);
});
