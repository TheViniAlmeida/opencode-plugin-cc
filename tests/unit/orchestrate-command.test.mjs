import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorDeps, createOrchestrationGroup, normalizeRequest, runWorker } from '../../plugins/opc/scripts/commands/orchestrate.mjs';
import { createGroup, readJob, jobLogPath, updateJob, consumeJobInput } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

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

function groupFixture(t) {
  const root = trackTempDir(t, makeTempDir('opc-orch-fix-'));
  const stateDir = path.join(root, 'state');
  ensurePrivateDir(stateDir);
  return { root, stateDir };
}

test('resolved member requests refresh the group pending state', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'running' }, [{ status: 'running', title: 'member' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: { policy: {}, routing: {} } };
  const deps = coordinatorDeps({ ctx, job: group, request: { timeoutSec: 1 }, conn: { api: {}, hub: {} }, discovery: {}, agentsIndex: new Map(), signal: new AbortController().signal,
    turnRunner: async ({ onPermission, onRequestResolved }) => {
      await onPermission({ id: 'per_test', sessionID: 'ses_test', permission: 'bash' });
      assert.equal(readJob(stateDir, group.id).status, 'waiting_permission');
      await onRequestResolved({ requestID: 'per_test', outcome: 'once' });
      return { status: 'completed', sessionID: 'ses_test' };
    },
    fallbackRunner: async (opts) => {
      await opts.runAttempt({ full: 'p/a', providerID: 'p', modelID: 'a' });
      return { result: { status: 'completed' }, attempts: [{ model: 'p/a' }] };
    },
  });
  await deps.runTurn({ role: 'worker', profile: 'write', prompt: 'p', title: 'member', memberId: members[0].id, candidates: [{ full: 'p/a', providerID: 'p', modelID: 'a' }] });
  await deps.flush();
  assert.equal(readJob(stateDir, group.id).status, 'running');
  assert.equal(readJob(stateDir, group.id).pendingRequest, null);
  assert.equal(readJob(stateDir, members[0].id).pendingRequest, null);
});

test('failed recordAttempt is logged and clears attemptInFlight', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'running' }, [{ status: 'running', title: 'member' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: { policy: {}, routing: {} } };
  await updateJob(stateDir, members[0].id, { attemptInFlight: true });
  const deps = coordinatorDeps({ ctx, job: group, request: {}, conn: { api: {}, hub: {} }, discovery: {}, agentsIndex: new Map(), signal: new AbortController().signal,
    attemptRecorder: async () => { throw new Error('simulated record failure'); },
    fallbackRunner: async (opts) => {
      await opts.onAttemptEnd({ model: 'p/a', status: 'failed' });
      return { result: { status: 'completed' }, attempts: [{ model: 'p/a' }] };
    },
  });
  await deps.runTurn({ role: 'worker', profile: 'read-only', prompt: 'p', title: 'member', memberId: members[0].id, candidates: [{ full: 'p/a' }] });
  await deps.flush();
  assert.equal(readJob(stateDir, members[0].id).attemptInFlight, false);
  assert.match(fs.readFileSync(jobLogPath(stateDir, group.id), 'utf8'), /falha ao registrar tentativa: simulated record failure/);
});

test('orchestrate registration uses createGroup under the server lock', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: { server: {}, jobs: { maxActive: 4 } } };
  const request = { task: 'audit', write: false, maxSubtasks: 3, synthesizer: 'claude', timeoutSec: 60 };
  const job = await createOrchestrationGroup(ctx, request, { candidates: ['planner'] }, null);
  assert.equal(job.role, 'group');
  assert.deepEqual(job.memberIds, []);
  assert.deepEqual(consumeJobInput(stateDir, job.id).plannerRoute, { candidates: ['planner'] });
});

test('runWorker finalizes through refreshGroup and its active-member guard', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, [{ status: 'completed', title: 'done' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
  const code = await runWorker(ctx, group, { task: 'audit', timeoutSec: 2 }, {
    openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
    discoveryLoader: async () => ({ agents: [] }),
    orchestrationRunner: async () => ({ status: 'completed', errorCode: null, errorMessage: null, summary: 'ok' }),
  });
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, group.id).status, 'completed');
  assert.equal(readJob(stateDir, group.id).result.summary, 'ok');
  assert.equal(readJob(stateDir, members[0].id).status, 'completed');
});

test('final group refresh refuses completion while a member remains active', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, [{ status: 'running', title: 'still running' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
  await runWorker(ctx, group, { task: 'audit', timeoutSec: 2 }, {
    openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
    discoveryLoader: async () => ({ agents: [] }),
    orchestrationRunner: async () => ({ status: 'completed', summary: 'premature' }),
  });
  assert.equal(readJob(stateDir, group.id).status, 'failed');
});
