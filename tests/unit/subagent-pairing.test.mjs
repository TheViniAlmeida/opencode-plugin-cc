import test from 'node:test';
import assert from 'node:assert/strict';
import { pairAgentsAndModels, MAX_SUBAGENTS, waitTimeoutMsFromFlags, buildMemberFields } from '../../plugins/opc/scripts/commands/subagent.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGroup } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

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

test('subagent member metadata creates no input files; only its group has private input', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-members-'));
  ensurePrivateDir(stateDir);
  const specs = [{ title: 'member 1', agent: 'general', model: { modelID: 'one' }, full: 'one', variant: null }];
  const { group } = await createGroup(stateDir, { kind: 'sub', request: { prompt: 'secret', members: specs } }, buildMemberFields(specs, 'summary', 'read-only'));
  const inputs = readdirSync(join(stateDir, 'jobs')).filter((name) => name.endsWith('.input.json'));
  assert.deepEqual(inputs, [`${group.id}.input.json`]);
});

test('--wait-timeout 0 is rejected as a usage error', () => {
  assert.throws(() => waitTimeoutMsFromFlags({ 'wait-timeout': 0 }), (error) => error.code === 'USAGE');
});
