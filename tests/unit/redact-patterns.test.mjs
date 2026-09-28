import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSecretPatterns } from '../../plugins/opc/scripts/lib/redact.mjs';

test('maskSecretPatterns masks common credential formats', () => {
  const tail = 'a'.repeat(24);
  const values = [
    ...['sk-', 'sk-' + 'proj-', 'sk-' + 'ant-', 'gh' + 'p_', 'gh' + 'o_', 'gh' + 's_',
      'github_' + 'pat_', 'gl' + 'pat-', 'xo' + 'xb-'].map((prefix) => prefix + tail),
    ...['AK' + 'IA', 'AS' + 'IA'].map((prefix) => prefix + 'A'.repeat(16)),
    'AI' + 'za' + 'a'.repeat(35),
    ['ey' + 'J' + 'a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)].join('.'),
    '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'private-' + 'material\n-----END ' + 'RSA PRIVATE KEY-----',
    'Bearer ' + 'token-' + 'material-' + '123456',
    'api_key=' + 'plain-' + 'secret-value',
    '"clientSecret": "' + 'json-' + 'secret-value"',
  ];
  const result = maskSecretPatterns(values.join('\n'));
  for (const value of values) assert.ok(!result.includes(value), `secret remains visible: ${value.slice(0, 20)}`);
  assert.equal((result.match(/\*\*\*/g) ?? []).length, values.length);
});

test('maskSecretPatterns leaves unrelated text unchanged', () => {
  assert.equal(maskSecretPatterns('ALLOW: arquivo validado; status=ok'), 'ALLOW: arquivo validado; status=ok');
});


test('assignment masking requires a secret-like key and a token-like value', () => {
  const value = 'opaque-' + 'value-123';
  for (const key of ['api_key', 'API_KEY', 'clientSecret', 'provider.password']) {
    for (const input of [`${key}=${value}`, `${key}="${value}"`, `"${key}": "${value}"`]) {
      assert.ok(!maskSecretPatterns(input).includes(value), input);
    }
  }
  assert.equal(maskSecretPatterns('token=' + 'a'.repeat(8)), 'token=***');
  const unchanged = [
    'LOCKED_KEY: --tty-confirm exige um terminal interativo',
    'UNKNOWN_KEY: chave de configuração desconhecida',
    'LOCKED_KEY: a confirmação não correspondeu; nada foi alterado',
    'password: ordinaryprose',
    '"password": ordinaryprose',
    'token=' + 'a'.repeat(7),
    'token=--tty-confirm',
    'token="--tty-confirm"',
    'token="ordinary prose"',
    '"token": "ordinary prose"',
    '"token": "--tty-confirm"',
    '"token": "short"',
    'model=public-model',
  ];
  for (const input of unchanged) assert.equal(maskSecretPatterns(input), input);
});
