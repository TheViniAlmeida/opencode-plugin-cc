import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY_CAP_ERROR_NAME, retryExceedsCap, retryCapError, classifyError,
} from '../../plugins/opc/scripts/lib/errors.mjs';

const CFG = { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 };
const NOW = 1_790_000_000_000;

test('attempt above maxProviderRetries exceeds the cap', () => {
  assert.equal(retryExceedsCap({ type: 'retry', attempt: 3, next: NOW + 1000 }, CFG, NOW), false);
  assert.equal(retryExceedsCap({ type: 'retry', attempt: 4, next: NOW + 1000 }, CFG, NOW), true);
});

test('next is an epoch-ms instant: waiting more than maxRetryWaitSec exceeds the cap', () => {
  assert.equal(retryExceedsCap({ type: 'retry', attempt: 1, next: NOW + 60_000 }, CFG, NOW), false);
  assert.equal(retryExceedsCap({ type: 'retry', attempt: 1, next: NOW + 60_001 }, CFG, NOW), true);
});

test('non-retry statuses and missing input never exceed the cap', () => {
  assert.equal(retryExceedsCap({ type: 'busy', attempt: 9, next: NOW + 999_000 }, CFG, NOW), false);
  assert.equal(retryExceedsCap({ type: 'idle' }, CFG, NOW), false);
  assert.equal(retryExceedsCap(null, CFG, NOW), false);
  assert.equal(retryExceedsCap({ type: 'retry', attempt: 1 }, CFG, NOW), false);
});

test('defaults are maxProviderRetries 3 and maxRetryWaitSec 60', () => {
  assert.equal(retryExceedsCap({ attempt: 4, next: NOW }, undefined, NOW), true);
  assert.equal(retryExceedsCap({ attempt: 1, next: NOW + 61_000 }, {}, NOW), true);
  assert.equal(retryExceedsCap({ attempt: 3, next: NOW + 59_000 }, {}, NOW), false);
  assert.equal(retryExceedsCap({ attempt: 4, next: NOW }, null, NOW), true);
});

test('retryCapError builds the synthetic error with attempt, wait and provider message', () => {
  const error = retryCapError({ type: 'retry', attempt: 4, next: NOW + 5000, message: 'Limite de requisições' }, NOW);
  assert.equal(error.name, RETRY_CAP_ERROR_NAME);
  assert.equal(RETRY_CAP_ERROR_NAME, 'RetryCapExceeded');
  assert.match(error.data.message, /tentativa 4, próxima em 5s\): Limite de requisições$/);
});

test('classifyError treats RetryCapExceeded as recoverable, even with tools run', () => {
  const error = retryCapError({ attempt: 9, next: NOW, message: 'x' }, NOW);
  const out = classifyError(error, { toolsRan: true });
  assert.equal(out.errorClass, 'recoverable');
  assert.equal(out.errorType, 'RetryCapExceeded');
  assert.equal(out.message, error.data.message);
});

test('classifyError keeps the F2a classes for the OpenCode union', () => {
  assert.equal(classifyError({ name: 'APIError', data: { message: 'r', statusCode: 429, isRetryable: true } }).errorClass, 'recoverable');
  assert.equal(classifyError({ name: 'ProviderAuthError', data: { providerID: 'p', message: 'chave inválida' } }).errorClass, 'fatal');
  assert.equal(classifyError({ name: 'MessageAbortedError', data: { message: 'abortado' } }).errorClass, 'fatal');
});
