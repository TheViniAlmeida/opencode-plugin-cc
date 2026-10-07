import assert from 'node:assert/strict';
import test from 'node:test';
import { toAgent, toFormAnswer, toPermissionRequest, toQuestion, toSessionStatus } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
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

test('normalizes V2 agents without retaining request settings', () => {
  const [build] = loadContractSample('agent.json').data;
  const agent = toAgent(build);
  assert.equal(agent.name, 'build');
  assert.equal(agent.native, true);
  assert.equal(agent.mode, 'primary');
  assert.equal(agent.hidden, false);
  assert.ok(!Object.hasOwn(agent, 'request'));
  assert.ok(!JSON.stringify(agent).includes('settings'));
});
