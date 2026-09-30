import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attempts, failureDetails } from '../live/_f4c-lib.mjs';

test('live failure details identify discards with at most 200 message characters', () => {
  const message = '$.position é obrigatório; '.repeat(20);
  assert.deepEqual(failureDetails({ failures: [{ label: 'B', round: 2, errorType: 'InvalidStructuredOutput', message }] }), [['B', 2, 'InvalidStructuredOutput', message.slice(0, 200)]]);
  assert.deepEqual(failureDetails(null), []);
  assert.deepEqual(failureDetails({ failures: [{ label: 'A', round: 1, errorType: 'Timeout' }] }), [['A', 1, 'Timeout', '']]);
});

test('live attempt diagnostics retain member failures when an assertion rejects the run', async () => {
  const failures = [['B', 1, 'InvalidStructuredOutput', '$.position é obrigatório']];
  const results = await attempts(2, async (i, detail) => {
    detail.failures = failures;
    assert.equal(i, 1, 'discarded member');
    return { jobId: 'conc_fixture' };
  });
  assert.deepEqual(results.map((r) => r.ok), [false, true]);
  assert.deepEqual(results[0].detail.failures, failures);
  assert.match(results[0].detail.error, /discarded member/);
  assert.deepEqual(results[1].detail, { failures, jobId: 'conc_fixture' });
});
