import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, createJob, updateJob, readJob, cancelJob, cancelGroup, recordAttempt, runJobTurn } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

test('F4b fix2: unpublished orchestration session defers cancellation and preserves attempt publication', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-preprompt-'));
  const { members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{ kind: 'orch', status: 'running', attemptInFlight: true }]);
  const result = await cancelJob({ stateDir }, member.id, { api: null, exitWaitMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.report.deferred, true);
  assert.equal(result.report.aborted, false);
  assert.equal(result.job.status, 'running');
  assert.ok(readJob(stateDir, member.id).cancelRequestedAt);
  await recordAttempt(stateDir, member.id, { status: 'cancelled', sessionID: 'ses_late' });
  await updateJob(stateDir, member.id, { status: 'cancelled' });
  assert.equal(readJob(stateDir, member.id).attempts.length, 1);
});

for (const kind of ['ask', 'orch', 'sub']) {
  test(`F4b fix2: unpublished ${kind} without a cooperating owner keeps CANCEL_FAILED`, async (t) => {
    const stateDir = trackTempDir(t, makeTempDir('opc-cancel-legacy-'));
    const job = kind === 'sub'
      ? (await createGroup(stateDir, { kind }, [{ kind, status: 'running', attemptInFlight: true }])).members[0]
      : await createJob(stateDir, { kind, attemptInFlight: true });
    const result = await cancelJob({ stateDir }, job.id, { api: null, exitWaitMs: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CANCEL_FAILED');
    assert.equal(result.report.deferred, undefined);
  });
}

for (const kind of ['conclave-member', 'conclave-judge']) {
  test(`F4c: unpublished ${kind} session defers cancellation to its coordinator`, async (t) => {
    const stateDir = trackTempDir(t, makeTempDir('opc-cancel-conclave-'));
    const { members: [member] } = await createGroup(stateDir, { kind: 'conclave' }, [{ kind, status: 'running', attemptInFlight: true }]);
    const result = await cancelJob({ stateDir }, member.id, { api: null, exitWaitMs: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.report.deferred, true);
    assert.equal(result.report.aborted, false);
    assert.ok(readJob(stateDir, member.id).cancelRequestedAt);
  });
}

test('F4b fix2: group cancellation stays deferred until the coordinator publishes its result', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-group-'));
  const { group, members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{ kind: 'orch', status: 'running', attemptInFlight: true }]);
  const result = await cancelGroup({ stateDir }, group.id);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.failedMembers, []);
  assert.deepEqual(result.deferredMembers, [member.id]);
  assert.deepEqual(result.cancelledMembers, [], 'a deferred member is not reported as cancelled');
  assert.ok(readJob(stateDir, group.id).cancelRequestedAt);
  assert.ok(readJob(stateDir, member.id).cancelRequestedAt);
  assert.notEqual(result.group.status, 'cancelled', 'do not freeze or terminate the coordinator before session cleanup');
});

test('F4b fix2: an orchestration member with its own pid keeps worker cancellation semantics', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-owned-'));
  const { members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{
    kind: 'orch', status: 'running', attemptInFlight: true, pid: process.pid, pidStartTime: 'identity-mismatch',
  }]);
  const result = await cancelJob({ stateDir }, member.id, { api: null, exitWaitMs: 1 });
  assert.equal(result.report.deferred, undefined);
  assert.equal(result.report.worker, 'identity-mismatch');
  assert.equal(result.job.status, 'cancelled');
});

test('F4b fix2: a published orchestration session still requires confirmed abort', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-published-'));
  const { members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{
    kind: 'orch', status: 'running', attemptInFlight: true, sessionID: 'ses_published',
  }]);
  // V2 interrupt() resolves {interrupted:false} for an idle session; confirmation comes from the session going idle.
  const api = { interrupt: async () => true, sessionStatus: async () => ({ ses_published: { type: 'busy' } }) };
  const result = await cancelJob({ stateDir }, member.id, { api, exitWaitMs: 1, idleWaitMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCEL_FAILED');
  assert.equal(result.report.deferred, undefined);
  assert.equal(result.job.cancelRequestedAt, null);
});

test('F4b gate: opc cancel reports a deferred group cancellation as pending, not cancelled', async (t) => {
  const { run } = await import('../../plugins/opc/scripts/commands/cancel.mjs');
  for (const json of [false, true]) {
    const stateDir = trackTempDir(t, makeTempDir('opc-cancel-cmd-'));
    const { group, members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{ kind: 'orch', status: 'running', attemptInFlight: true }]);
    const out = []; const jsonOut = [];
    const ctx = { stateDir, out: (s) => out.push(s), err: (s) => out.push(s), json: (v) => jsonOut.push(v) };
    const code = await run(ctx, [group.id, ...(json ? ['--json'] : [])]);
    assert.equal(code, 0);
    if (json) {
      assert.equal(jsonOut[0].pending, true);
      assert.deepEqual(jsonOut[0].deferredMembers, [member.id]);
      assert.deepEqual(jsonOut[0].cancelledMembers, []);
    } else {
      assert.match(out.join(''), new RegExp(`# Cancelamento do grupo ${group.id} pendente`));
      assert.match(out.join(''), new RegExp(`pendente \\(sessão em criação\\): ${member.id}`));
      assert.doesNotMatch(out.join(''), /Grupo .* cancelado/);
    }
  }
});

test('F4b gate: opc cancel of a deferred member says pending', async (t) => {
  const { run } = await import('../../plugins/opc/scripts/commands/cancel.mjs');
  const { renderCancel } = await import('../../plugins/opc/scripts/lib/render.mjs');
  const text = renderCancel({ id: 'orch-a-b', kind: 'orch' }, { deferred: true, aborted: false, worker: 'not-running' });
  assert.match(text, /Cancelamento de orch-a-b \(orch\) pendente/);
  assert.doesNotMatch(text, /^Cancelada /m);
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-member-'));
  const { members: [member] } = await createGroup(stateDir, { kind: 'orch' }, [{ kind: 'orch', status: 'running', attemptInFlight: true }]);
  const jsonOut = [];
  const code = await run({ stateDir, out: () => {}, err: () => {}, json: (v) => jsonOut.push(v) }, [member.id, '--json']);
  assert.equal(code, 0);
  assert.equal(jsonOut[0].pending, true);
  assert.equal(jsonOut[0].status, 'running');
});

test('cancel during session creation aborts the session published while waiting and finishes cancelled', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-creating-'));
  const job = await createJob(stateDir, { kind: 'task', status: 'running', attemptInFlight: true });
  const aborted = [];
  const api = {
    interrupt: async (sessionID) => {
      aborted.push(sessionID);
      // The worker's turn ends once its session is aborted.
      setTimeout(() => { void updateJob(stateDir, job.id, { attemptInFlight: false }); }, 20);
      return true;
    },
    sessionStatus: async () => ({}),
  };
  setTimeout(() => { void updateJob(stateDir, job.id, { sessionID: 'ses_late', childSessionIDs: ['ses_child'] }); }, 60);
  const result = await cancelJob({ stateDir }, job.id, { api, exitWaitMs: 2000 });
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.deepEqual(aborted, ['ses_late', 'ses_child']);
  assert.equal(result.report.aborted, true);
  assert.equal(result.job.status, 'cancelled');
});

test('runJobTurn hands the turn an isCancelled that sees intent persisted after the attempt started', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-cancel-intent-'));
  const job = await createJob(stateDir, { kind: 'task', status: 'running' });
  const seen = [];
  await runJobTurn({
    stateDir, job: { ...job, request: {} }, baseTurnRequest: { model: { providerID: 'p', modelID: 'm' }, parts: [] },
    runTurnImpl: async ({ isCancelled }) => {
      seen.push(isCancelled());
      await updateJob(stateDir, job.id, { cancelRequestedAt: new Date().toISOString() });
      seen.push(isCancelled());
      return { status: 'cancelled', sessionID: 'ses_x' };
    },
  });
  assert.deepEqual(seen, [false, true]);
});
