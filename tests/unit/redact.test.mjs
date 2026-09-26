import assert from 'node:assert/strict';
import test from 'node:test';

import { SECRET_KEYS, redact, redactText, registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

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
  assert.deepEqual(out.list[1].tokens, { input: 3 });
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
