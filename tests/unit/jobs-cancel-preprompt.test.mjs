import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, createJob, updateJob, readJob, cancelJob, cancelGroup, recordAttempt } from '../../plugins/opc/scripts/lib/jobs.mjs';
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
  const result = await cancelJob({ stateDir }, member.id, { api: { abort: async () => false }, exitWaitMs: 1 });
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
