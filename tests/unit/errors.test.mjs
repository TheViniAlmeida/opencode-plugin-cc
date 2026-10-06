import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, retryExceedsCap } from '../../plugins/opc/scripts/lib/errors.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const cases = [
  [{ name: 'APIError', data: { message: '429', isRetryable: true, statusCode: 429 } }, {}, 'recoverable'],
  [{ name: 'APIError', data: { message: 'no model', isRetryable: false, statusCode: 404 } }, {}, 'recoverable'],
  [{ name: 'APIError', data: { message: 'bad', isRetryable: false, statusCode: 400 } }, {}, 'fatal'],
  [{ name: 'RetryCapExceeded', data: { message: 'cap' } }, {}, 'recoverable'],
  [{ name: 'Timeout', data: { message: 't' } }, {}, 'recoverable'],
  [{ name: 'StructuredOutputError', data: { message: 's', retries: 1 } }, { toolsRan: false }, 'recoverable'],
  [{ name: 'StructuredOutputError', data: { message: 's', retries: 1 } }, { toolsRan: true }, 'fatal'],
  [{ name: 'ContextOverflowError', data: { message: 'c' } }, {}, 'fatal'],
  [{ name: 'ContextOverflowError', data: { message: 'c' } }, { candidateHasLargerContext: true }, 'recoverable'],
  [{ name: 'ProviderAuthError', data: { providerID: 'p', message: 'k' } }, {}, 'fatal'],
  [{ name: 'MessageAbortedError', data: { message: 'a' } }, {}, 'fatal'],
  [{ name: 'ContentFilterError', data: { message: 'f' } }, {}, 'fatal'],
  [{ name: 'MessageOutputLengthError', data: {} }, {}, 'fatal'],
  [{ name: 'UnknownError', data: { message: 'u' } }, {}, 'fatal'],
  [{ name: 'BadRequest', data: { message: 'b' } }, {}, 'fatal'],
  [{ name: 'ServerLost', data: { message: 'l' } }, {}, 'fatal'],
  [{ name: 'Cancelled', data: { message: 'x' } }, {}, 'fatal'],
];

for (const [error, opts, expected] of cases) {
  test(`classifyError ${error.name} ${JSON.stringify(opts)} → ${expected}`, () => {
    const r = classifyError(error, opts);
    assert.equal(r.errorClass, expected);
    assert.equal(r.errorType, error.name);
    assert.equal(typeof r.message, 'string');
  });
}

test('classifyError tolerates missing name and huge messages', () => {
  assert.equal(classifyError({}).errorType, 'UnknownError');
  assert.equal(classifyError(null).errorClass, 'fatal');
  const r = classifyError({ name: 'UnknownError', data: { message: 'x'.repeat(5000) } });
  assert.ok(r.message.length <= 2001);
});

test('classifyError safely describes circular unknown errors', () => {
  const error = { name: 'UnknownError', code: 'E_UNKNOWN' };
  error.self = error;

  assert.deepEqual(classifyError(error), {
    errorClass: 'fatal',
    errorType: 'UnknownError',
    message: 'Erro do OpenCode.',
  });
});

test('classifyError redacts registered secrets and preserves the expected message', () => {
  const secret = 'opc-test-secret-value';
  registerSecret(secret);

  const result = classifyError({ name: 'UnknownError', message: `request failed with ${secret}` });

  assert.equal(result.message, 'Erro do OpenCode.');
  assert.ok(!result.message.includes(secret));
});

for (const [type, expectedClass, expectedMessage] of [
  ['provider.no-route', 'fatal', 'Modelo indisponível.'],
  ['provider.rate-limit', 'recoverable', 'Limite de requisições do provedor atingido.'],
  ['aborted', 'fatal', 'Turno cancelado.'],
]) {
  test(`V2 ${type} is classified with a Portuguese message`, () => {
    const result = classifyError({ type, message: 'p/modelo-privado' });
    assert.equal(result.errorClass, expectedClass);
    assert.equal(result.errorType, type);
    assert.equal(result.message, expectedMessage);
  });
}

test('V2 permission rejection during a tool is recoverable', () => {
  const result = classifyError({ type: 'permission.rejected', message: 'private path' }, { toolsRan: true });
  assert.equal(result.errorClass, 'recoverable');
  assert.equal(result.message, 'Permissão recusada.');
});

test('V2 HTTP 429 is recoverable even without APIError', () => {
  const result = classifyError({ type: 'provider.http', status: 429, message: 'private model' });
  assert.equal(result.errorClass, 'recoverable');
  assert.equal(result.errorType, 'provider.http');
  assert.equal(result.message, 'Limite de requisições do provedor atingido.');
});

test('retryExceedsCap: attempt above max or wait above max', () => {
  const cfg = { maxProviderRetries: 3, maxRetryWaitSec: 60 };
  const now = 1_000_000;
  assert.equal(retryExceedsCap({ attempt: 3, next: now + 1000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 4, next: now + 1000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 61_000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 60_000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 1 }, {}, now), false);
});
