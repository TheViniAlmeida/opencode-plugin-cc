import assert from 'node:assert/strict';
import test from 'node:test';
import { toFormAnswer, toPermissionRequest, toQuestion, toSessionStatus } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

test('normalizes the recorded permission request and form', () => {
  const req = toPermissionRequest(loadContractSample('permission-request.json'));
  assert.equal(req.permission, 'shell');
  assert.deepEqual(req.patterns, ['echo opc-probe']);
  assert.equal(req.metadata.command, 'echo opc-probe');
  const q = toQuestion(loadContractSample('form.json'));
  assert.equal(q.questions[0].key, 'q0');
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ['Red', 'Blue']);
  assert.deepEqual(toFormAnswer(q, [['Blue']]), { answer: { q0: 'Blue' } });
  assert.deepEqual(toSessionStatus({ ses_a: { type: 'running' } }), { ses_a: { type: 'busy' } });
  assert.deepEqual(toSessionStatus({}), {});
});
