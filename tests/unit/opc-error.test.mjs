import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionError, ExitCode, NotFoundError, OpcError, PolicyError, RequestError, UsageError, toExitCode,
} from '../../plugins/opc/scripts/lib/opc-error.mjs';

test('ExitCode matches spec §4.1 and is frozen', () => {
  assert.deepEqual({ ...ExitCode }, { OK: 0, USAGE: 2, WAITING: 3, POLICY: 4, CONNECTION: 5, WAIT_TIMEOUT: 6, JOB_FAILED: 7, CANCELLED: 130 });
  assert.ok(Object.isFrozen(ExitCode));
});

test('OpcError carries code, exitCode, details and cause', () => {
  const cause = new Error('root');
  const err = new OpcError('SOMETHING', 'msg', { exitCode: 3, details: { a: 1 }, cause });
  assert.equal(err.code, 'SOMETHING');
  assert.equal(err.message, 'msg');
  assert.equal(err.exitCode, 3);
  assert.deepEqual(err.details, { a: 1 });
  assert.equal(err.cause, cause);
  assert.equal(new OpcError('X').exitCode, ExitCode.JOB_FAILED);
});

test('subclasses have default codes and exit codes', () => {
  const cases = [
    [new UsageError(), 'USAGE', 2, 'UsageError'],
    [new PolicyError(), 'POLICY_DENIED', 4, 'PolicyError'],
    [new ConnectionError(), 'SERVER_DOWN', 5, 'ConnectionError'],
    [new NotFoundError(), 'NOT_FOUND', 2, 'NotFoundError'],
    [new RequestError(), 'SERVER_ERROR', 7, 'RequestError'],
  ];
  for (const [err, code, exitCode, name] of cases) {
    assert.ok(err instanceof OpcError);
    assert.equal(err.code, code);
    assert.equal(err.exitCode, exitCode);
    assert.equal(err.name, name);
  }
  const custom = new ConnectionError('AUTH_FAILED', 'nope');
  assert.equal(custom.code, 'AUTH_FAILED');
  assert.equal(custom.exitCode, 5);
  assert.equal(new UsageError('TOO_MANY_JOBS', 'x').exitCode, 2);
});

test('toExitCode maps OpcError to its exitCode and anything else to 7', () => {
  assert.equal(toExitCode(new PolicyError('POLICY_DENIED', 'x')), 4);
  assert.equal(toExitCode(new Error('boom')), 7);
  assert.equal(toExitCode('string'), 7);
});
