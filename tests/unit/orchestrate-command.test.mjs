import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorDeps, createOrchestrationGroup, normalizeRequest, runWorker } from '../../plugins/opc/scripts/commands/orchestrate.mjs';
import { createGroup, readJob, jobLogPath, updateJob, consumeJobInput } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { Readable } from 'node:stream';
import { parseArgs, readRawArgs } from '../../plugins/opc/scripts/lib/args.mjs';
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
test('opc orchestrate --raw-args-stdin parses flags from the heredoc body', async () => {
  const spec = { 'raw-args-stdin': { type: 'boolean' }, planner: { type: 'string' }, model: { type: 'string', alias: 'm' }, max: { type: 'number' }, synthesizer: { type: 'string' }, write: { type: 'boolean' }, background: { type: 'boolean' }, timeout: { type: 'number' }, 'wait-timeout': { type: 'number' }, json: { type: 'boolean' } };
  const raw = await readRawArgs(['--raw-args-stdin'], spec, { stdin: Readable.from(['--max 2 --synthesizer claude\n--\nInvestigate independent modules\n']) });
  const { flags, positionals } = parseArgs(raw.argv, { flags: spec, allowPositionals: true });
  assert.deepEqual(normalizeRequest(config, flags, [raw.text]), { task: 'Investigate independent modules', maxSubtasks: 2, write: false, background: false, json: false, planner: null, synthesizer: 'claude', synthesizerModel: null, timeoutSec: 1800, waitTimeoutSec: null });
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

test('C2: failed recordAttempt fails the coordinator and clears attemptInFlight', async (t) => {
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
  await assert.rejects(deps.runTurn({ role: 'worker', profile: 'read-only', prompt: 'p', title: 'member', memberId: members[0].id, candidates: [{ full: 'p/a' }] }), (err) => err.code === 'coordinator_error');
  await assert.rejects(deps.flush(), (err) => err.code === 'coordinator_error');
  assert.equal(readJob(stateDir, members[0].id).attemptInFlight, false);
  assert.match(fs.readFileSync(jobLogPath(stateDir, group.id), 'utf8'), /falha ao registrar tentativa: .*simulated record failure/);
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

test('an invalid plan after a completed planner fails the group and keeps the planner completed', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, [{ status: 'completed', role: 'planner', title: 'planner' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
  const code = await runWorker(ctx, group, { task: 'audit', timeoutSec: 2 }, {
    openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
    discoveryLoader: async () => ({ agents: [] }),
    orchestrationRunner: async () => ({ status: 'failed', errorCode: 'invalid_plan', errorMessage: 'invalid plan', summary: 'rejected' }),
  });
  assert.notEqual(code, 0);
  assert.equal(readJob(stateDir, group.id).status, 'failed');
  assert.equal(readJob(stateDir, members[0].id).status, 'completed');
});

test('an orchestration exception after a completed member fails the group', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, [{ status: 'completed', role: 'planner', title: 'planner' }]);
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
  const code = await runWorker(ctx, group, { task: 'audit', timeoutSec: 2 }, {
    openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
    discoveryLoader: async () => ({ agents: [] }),
    orchestrationRunner: async () => { throw new Error('orchestration failed'); },
  });
  assert.notEqual(code, 0);
  assert.equal(readJob(stateDir, group.id).status, 'failed');
  assert.equal(readJob(stateDir, members[0].id).status, 'completed');
});

test('a requested cancellation remains cancelled when orchestration returns completed', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, []);
  await updateJob(stateDir, group.id, { cancelRequestedAt: new Date().toISOString() });
  const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
  const code = await runWorker(ctx, group, { task: 'audit', timeoutSec: 2 }, {
    openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
    discoveryLoader: async () => ({ agents: [] }),
    orchestrationRunner: async () => ({ status: 'completed', summary: 'done' }),
  });
  assert.notEqual(code, 0);
  assert.equal(readJob(stateDir, group.id).status, 'cancelled');
});

test('C1: member sessions are persisted while an attempt is in flight', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group, members } = await createGroup(stateDir, { kind: 'orch', status: 'running' }, [{ status: 'running' }]);
  const memberId = members[0].id;
  const deps = coordinatorDeps({ ctx: { stateDir, workspaceRoot: root, config: {}, env: {} }, job: group, request: {}, conn: { api: {}, hub: {} }, discovery: {},
    turnRunner: async ({ onSession }) => {
      await onSession({ sessionID: 'ses_active', childSessionIDs: [] });
      assert.equal(readJob(stateDir, memberId).sessionID, 'ses_active');
      assert.equal(readJob(stateDir, memberId).attemptInFlight, true);
      await onSession({ sessionID: 'ses_active', childSessionIDs: ['ses_child'] });
      assert.deepEqual(readJob(stateDir, memberId).childSessionIDs, ['ses_child']);
      return { status: 'completed', sessionID: 'ses_active' };
    },
  });
  await deps.runTurn({ role: 'worker', profile: 'read-only', prompt: 'p', title: 'member', memberId, candidates: [{ full: 'p/a', providerID: 'p', modelID: 'a' }] });
});

test('I1: fallback cancelled before its first attempt returns cancelled and exit 130', async (t) => {
  const { root, stateDir } = groupFixture(t);
  const { group } = await createGroup(stateDir, { kind: 'orch', status: 'running' }, []);
  const controller = new AbortController(); controller.abort();
  const deps = coordinatorDeps({ ctx: { stateDir, workspaceRoot: root, config: {}, env: {} }, job: group, request: {}, conn: { api: {}, hub: {} }, discovery: {}, signal: controller.signal,
    turnRunner: async () => assert.fail('no turn may start'),
  });
  const result = await deps.runTurn({ role: 'planner', profile: 'read-only', prompt: 'p', title: 'planner', candidates: [{ full: 'p/a' }] });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.attempts, []);
  const { exitCodeForJob } = await import('../../plugins/opc/scripts/commands/task.mjs');
  assert.equal(exitCodeForJob(result), 130);
});

for (const operation of ['start', 'finish', 'update']) {
  test(`C2: ${operation} failure persists a failed group with masked coordinator diagnostics`, async (t) => {
    const { runOrchestration } = await import('../../plugins/opc/scripts/lib/orchestrator.mjs');
    const { root, stateDir } = groupFixture(t);
    const { group } = await createGroup(stateDir, { kind: 'orch', status: 'queued' }, []);
    const secret = ['sk', 'proj', 'gatepersist123456789'].join('-');
    let turns = 0;
    const ctx = { stateDir, workspaceRoot: root, env: {}, config: {} };
    const code = await runWorker(ctx, group, { task: 'audit', plannerRoute: { candidates: [{ full: 'p/a' }] } }, {
      openApiImpl: async () => ({ api: {}, hub: {}, close() {} }),
      discoveryLoader: async () => ({ agents: [] }),
      orchestrationRunner: async (args) => {
        args.deps.members[operation] = async () => { throw new Error(`storage failed ${secret}`); };
        args.deps.runTurn = async (spec) => {
          turns += 1;
          if (operation === 'update') {
            const { coordinatorError } = await import('../../plugins/opc/scripts/lib/orchestrator.mjs');
            try { await args.deps.members.update(spec.memberId, { sessionID: 'ses_active' }); }
            catch (err) { throw coordinatorError(err); }
          }
          return { status: 'completed', structured: { rationale: 'r', subtasks: [] } };
        };
        return runOrchestration(args);
      },
    });
    assert.equal(code, 7);
    const stored = readJob(stateDir, group.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.errorCode, 'coordinator_error');
    assert.match(stored.errorMessage, /storage failed/);
    assert.equal(stored.errorMessage.includes(secret), false);
    const log = fs.readFileSync(jobLogPath(stateDir, group.id), 'utf8');
    assert.match(log, /storage failed/);
    assert.equal(log.includes(secret), false);
    assert.equal(turns, operation === 'start' ? 0 : 1);
  });
}
