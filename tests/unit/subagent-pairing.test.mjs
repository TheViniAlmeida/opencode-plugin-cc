import test from 'node:test';
import assert from 'node:assert/strict';
import { pairAgentsAndModels, MAX_SUBAGENTS } from '../../plugins/opc/scripts/commands/subagent.mjs';

test('pairAgentsAndModels expande 1×N e N×1 e pareia N×N', () => {
  assert.deepEqual(pairAgentsAndModels(['general'], ['a', 'b', 'c']), [
    { agent: 'general', model: 'a' }, { agent: 'general', model: 'b' }, { agent: 'general', model: 'c' },
  ]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], []), [{ agent: 'x', model: null }, { agent: 'y', model: null }]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], ['a']), [{ agent: 'x', model: 'a' }, { agent: 'y', model: 'a' }]);
  assert.deepEqual(pairAgentsAndModels(['x', 'y'], ['a', 'b']), [{ agent: 'x', model: 'a' }, { agent: 'y', model: 'b' }]);
});

test('pairAgentsAndModels rejeita divergência, ausência de agente e grupos grandes', () => {
  assert.throws(() => pairAgentsAndModels(['x', 'y'], ['a', 'b', 'c']), (e) => e.exitCode === 2 && e.code === 'AGENT_MODEL_MISMATCH');
  assert.throws(() => pairAgentsAndModels([], ['a']), (e) => e.code === 'NO_AGENT');
  assert.equal(MAX_SUBAGENTS, 8);
  assert.throws(() => pairAgentsAndModels(Array(9).fill('general'), []), (e) => e.code === 'TOO_MANY_SUBAGENTS');
});
