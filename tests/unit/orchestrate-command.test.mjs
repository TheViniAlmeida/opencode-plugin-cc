import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../../plugins/opc/scripts/commands/orchestrate.mjs';

const config = { orchestrate: { planner: 'strong', maxSubtasks: 5, synthesizer: 'claude' } };

test('task comes from positionals and defaults come from config', () => {
  const r = normalizeRequest(config, { write: false, background: false, json: false }, ['Audit', 'the', 'repo']);
  assert.deepEqual(r, { task: 'Audit the repo', maxSubtasks: 5, write: false, background: false, json: false, planner: null, synthesizer: 'claude', synthesizerModel: null, timeoutSec: 1800, waitTimeoutSec: null });
});
test('flags override config', () => {
  const r = normalizeRequest(config, { max: 3, planner: 'k3', synthesizer: 'fast', write: true, background: true, timeout: 60, 'wait-timeout': 5 }, ['t']);
  assert.equal(r.maxSubtasks, 3); assert.equal(r.planner, 'k3'); assert.equal(r.synthesizer, 'model'); assert.equal(r.synthesizerModel, 'fast'); assert.equal(r.write, true); assert.equal(r.background, true); assert.equal(r.timeoutSec, 60); assert.equal(r.waitTimeoutSec, 5);
});
test('-m/--model acts as the planner model', () => {
  assert.equal(normalizeRequest(config, { model: 'k3' }, ['t']).planner, 'k3');
  assert.throws(() => normalizeRequest(config, { model: 'k3', planner: 'fast' }, ['t']), (err) => err.code === 'USAGE' && /--planner e --model divergem/.test(err.message));
});
test('config synthesizer model is used when no flag is given', () => {
  const r = normalizeRequest({ orchestrate: { synthesizer: 'strong' } }, {}, ['t']); assert.deepEqual([r.synthesizer, r.synthesizerModel], ['model', 'strong']);
});
test('usage errors exit with code 2', () => {
  const cases = [[{}, []], [{ max: 1 }, ['t']], [{ max: 11 }, ['t']], [{ max: 2.5 }, ['t']], [{ synthesizer: '' }, ['t']], [{ timeout: 0 }, ['t']], [{ 'wait-timeout': -1 }, ['t']]];
  for (const [flags, positionals] of cases) assert.throws(() => normalizeRequest(config, flags, positionals), (err) => err.exitCode === 2 && /uso: opc orchestrate/.test(err.message), JSON.stringify(flags));
});
test('invalid orchestrate.maxSubtasks in config is reported by its key', () => {
  assert.throws(() => normalizeRequest({ orchestrate: { maxSubtasks: 50 } }, {}, ['t']), (err) => err.code === 'USAGE' && /orchestrate\.maxSubtasks deve ser/.test(err.message));
});
test('the worker dispatches orch jobs to runWorker through WORKER_DELEGATES', async () => {
  const { WORKER_DELEGATES } = await import('../../plugins/opc/scripts/commands/task-worker.mjs'); assert.equal(WORKER_DELEGATES.orch, './orchestrate.mjs');
  const mod = await import('../../plugins/opc/scripts/commands/orchestrate.mjs'); assert.equal(typeof mod.runWorker, 'function');
});
