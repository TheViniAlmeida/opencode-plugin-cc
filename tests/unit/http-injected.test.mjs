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

test('auth, directory precedence, JSON request/response, and 204', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'http://opencode.test/', password: PASSWORD, directory: '/workspace here',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return calls.length === 4 ? response(204) : response(200, { ok: true });
    },
  });
  assert.deepEqual(await client.get('/health'), { ok: true });
  assert.deepEqual(await client.post('/items', { value: 1 }), { ok: true });
  await client.patch('/items/1', { value: 2 }, { query: { directory: '/override', n: 5 } });
  assert.equal(await client.get('/empty'), null);
  assert.equal(calls[0].options.headers.authorization, `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`);
  assert.equal(calls[0].url.searchParams.get('directory'), '/workspace here');
  assert.equal(calls[1].options.body, '{"value":1}');
  assert.equal(calls[2].url.searchParams.get('directory'), '/override');
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

test('timeout maps to TIMEOUT; GET retries once and POST retry is opt-in', async () => {
  const timeoutClient = createClient({
    baseUrl: 'http://opencode.test', requestTimeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(timeoutClient.get('/hang', { retryOnServerDown: false }), (err) => err.code === 'TIMEOUT' && err.exitCode === 5);

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
  assert.deepEqual(await client.get('/health'), { host: 'up.test' });
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
  await assert.rejects(postClient.post('/items', {}), (err) => err instanceof ConnectionError && err.code === 'SERVER_DOWN');
  assert.equal(postRecoveryCalls, 0);
  assert.deepEqual(await postClient.post('/items', {}, { retryOnServerDown: true }), { ok: true });
  assert.equal(postRecoveryCalls, 1);
});
