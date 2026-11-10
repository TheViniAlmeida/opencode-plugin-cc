import assert from 'node:assert/strict';
import test from 'node:test';

import { SECRET_KEYS, maskDeep, maskSecretPatterns, redact, redactText, registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

test('SECRET_KEYS lists the keys of spec §3.1', () => {
  for (const k of ['key', 'apiKey', 'apikey', 'password', 'authorization', 'headers', 'responseHeaders', 'token', 'secret']) {
    assert.ok(SECRET_KEYS.includes(k), k);
  }
});

test('redact masks secret keys deeply without mutating the input', () => {
  const input = {
    provider: { options: { apiKey: 'sk-live-123', headers: { 'x-a': 'b' }, baseURL: 'https://x' }, key: 'k' },
    list: [{ Authorization: 'Basic abc' }, { token: 't', tokens: { input: 3 } }],
    OPENCODE_SERVER_PASSWORD: 'p',
    nothing: null,
  };
  const out = redact(input);
  assert.equal(out.provider.options.apiKey, '***');
  assert.equal(out.provider.options.headers, '***');
  assert.equal(out.provider.options.baseURL, 'https://x');
  assert.equal(out.provider.key, '***');
  assert.equal(out.list[0].Authorization, '***');
  assert.equal(out.list[1].token, '***');
  assert.equal(out.list[1].tokens, '***', 'the shared config predicate conservatively classifies token-like keys');
  assert.equal(out.OPENCODE_SERVER_PASSWORD, '***');
  assert.equal(out.nothing, null);
  assert.equal(input.provider.options.apiKey, 'sk-live-123');
});

test('registered secrets are replaced in text and nested strings; short values are ignored', () => {
  const secret = 'f00dbabe'.repeat(4);
  registerSecret(secret);
  registerSecret('short');
  assert.equal(redactText(`url ${secret} end ${secret}`), 'url *** end ***');
  assert.equal(redactText('short stays'), 'short stays');
  assert.deepEqual(redact({ msg: `x${secret}y`, arr: [secret] }), { msg: 'x***y', arr: ['***'] });
});

test('redact turns Error objects into safe plain objects', () => {
  const secret = 'c0ffee00'.repeat(4);
  registerSecret(secret);
  const err = Object.assign(new Error(`failed with ${secret}`), { code: 'E' });
  assert.deepEqual(redact(err), { name: 'Error', code: 'E', message: 'failed with ***' });
});


test('longer registered secrets are fully masked regardless of registration order', () => {
  registerSecret('abcdefgh12');
  registerSecret('abcdefgh12XYZ9876');
  const redacted = redactText('abcdefgh12XYZ9876');
  assert.ok(!redacted.includes('XYZ9876'));
  assert.ok(!redacted.includes('abcdefgh'));
});

test('redact masks registered secrets in Error code and name', () => {
  const secret = 'errorcode-secret-123';
  registerSecret(secret);
  const err = Object.assign(new Error('safe message'), { code: `E_${secret}` });
  err.name = `Custom_${secret}`;
  const out = redact(err);
  assert.ok(out.code.includes('***'));
  assert.ok(!out.code.includes(secret));
  assert.ok(out.name.includes('***'));
  assert.ok(!out.name.includes(secret));
});

test('maskDeep pattern-masks nested strings, leaves keys untouched, and does not mutate', () => {
  const token = `sk-proj-${'Q'.repeat(24)}`;
  const input = { [token]: [ `before ${token}`, { value: token } ], unchanged: null };
  const out = maskDeep(input);
  assert.deepEqual(out, { [token]: [`before ***`, { value: '***' }], unchanged: null });
  assert.equal(input[token][0], `before ${token}`);
});

test('pattern masking reports replacements without counting existing masks or overlapping patterns twice', () => {
  const token = `sk-${'A'.repeat(40)}`;
  const key = ['-----BEGIN PRIVATE KEY-----', 'already ***', '-----END PRIVATE KEY-----'].join('\n');
  let count = 0;
  const out = maskSecretPatterns(`already *** password=*** ${token} Bearer ${token} password=fixture-value ${key}`, { onMask: () => { count += 1; } });
  assert.equal(out, 'already *** password=*** *** Bearer *** password=*** ***');
  assert.equal(count, 4);
});

for (const status of [400, 401, 404, 500]) {
  for (const asJson of [true, false]) {
    test(`HTTP ${status} masks secret patterns in ${asJson ? 'JSON' : 'plain text'} error details`, async () => {
      const token = `sk-${'A'.repeat(40)}`;
      const body = asJson ? JSON.stringify({ message: `bad key ${token}`, nested: { note: `Bearer ${'abc0'.repeat(9)}` } }) : `bad key ${token}`;
      const client = createClient({ baseUrl: 'http://opencode.invalid', fetchImpl: async () => new Response(body, { status }) });
      await assert.rejects(client.get('/api/info'), (error) => {
        assert.equal(JSON.stringify(error.details).includes(token), false);
        assert.doesNotMatch(JSON.stringify(error.details), /Bearer abc/);
        assert.equal(error.details.status, status);
        assert.match(JSON.stringify(error.details.body), /bad key \*\*\*/);
        return true;
      });
    });
  }
}

for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
  test(`HTTP client refuses redirect status ${status} without retrying or reading the body`, async () => {
    let options;
    let calls = 0;
    let retries = 0;
    const client = createClient({
      baseUrl: 'http://opencode.invalid',
      fetchImpl: async (_url, init) => { options = init; calls += 1; return { status, text() { throw new Error('redirect body must not be read'); } }; },
      onServerDown: async () => { retries += 1; },
    });
    await assert.rejects(client.get('/api/info'), (error) => {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.code, 'UNEXPECTED_REDIRECT');
      assert.equal(error.exitCode, 5);
      assert.equal(error.message, 'GET /api/info: o servidor respondeu com redirecionamento; configure a URL final.');
      return true;
    });
    assert.equal(options.redirect, 'manual');
    assert.equal(calls, 1);
    assert.equal(retries, 0);
  });
}
