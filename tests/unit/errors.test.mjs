import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, retryExceedsCap } from '../../plugins/opc/scripts/lib/errors.mjs';

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

test('retryExceedsCap: attempt above max or wait above max', () => {
  const cfg = { maxProviderRetries: 3, maxRetryWaitSec: 60 };
  const now = 1_000_000;
  assert.equal(retryExceedsCap({ attempt: 3, next: now + 1000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 4, next: now + 1000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 61_000 }, cfg, now), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: now + 60_000 }, cfg, now), false);
  assert.equal(retryExceedsCap({ attempt: 1 }, {}, now), false);
});
