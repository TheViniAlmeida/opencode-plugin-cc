import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, readJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { finalizeConclaveCoordinatorFailure, renderConclaveForeground } from '../../plugins/opc/scripts/commands/conclave.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

function stateDir(t) {
  const dir = trackTempDir(t, makeTempDir('opc-conclave-worker-'));
  ensurePrivateDir(dir);
  return dir;
}

test('coordinator failure closes active members and judge before final group refresh', async (t) => {
  const dir = stateDir(t);
  const { group, members } = await createGroup(dir, { kind: 'conclave', title: 'test conclave', workspaceRoot: '/workspace' }, [
    { kind: 'conclave-member', title: 'member A', role: 'member:A' },
    { kind: 'conclave-judge', title: 'judge', role: 'judge' },
  ]);
  await updateJob(dir, group.id, { status: 'running' });
  for (const member of members) await updateJob(dir, member.id, { status: 'running', attemptInFlight: true });
  const error = Object.assign(new Error('event handler failed'), { code: 'COORDINATOR_ERROR' });
  const completedAt = '2026-09-30T12:00:00.000Z';
  const final = await finalizeConclaveCoordinatorFailure(dir, readJob(dir, group.id), members.map((member) => member.id), error, () => completedAt);
  assert.equal(final.status, 'failed');
  for (const member of members) {
    const closed = readJob(dir, member.id);
    assert.equal(closed.status, 'failed');
    assert.equal(closed.errorCode, 'coordinator_error');
    assert.equal(closed.attemptInFlight, false);
    assert.equal(closed.completedAt, completedAt);
  }
  assert.equal(final.result.members.some((member) => ['queued', 'running', 'waiting'].includes(member.status)), false);
});

test('coordinator failure cancels active children when cancellation was requested', async (t) => {
  const dir = stateDir(t);
  const { group, members } = await createGroup(dir, { kind: 'conclave', title: 'test conclave', workspaceRoot: '/workspace' }, [
    { kind: 'conclave-member', title: 'member A', role: 'member:A' },
  ]);
  await updateJob(dir, group.id, { status: 'running', cancelRequestedAt: '2026-09-30T11:59:00.000Z' });
  await updateJob(dir, members[0].id, { status: 'running', attemptInFlight: true });
  const final = await finalizeConclaveCoordinatorFailure(dir, readJob(dir, group.id), [members[0].id], new Error('cancel race'), () => '2026-09-30T12:00:00.000Z');
  const child = readJob(dir, members[0].id);
  assert.equal(child.status, 'cancelled');
  assert.equal(child.attemptInFlight, false);
  assert.equal(child.completedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(final.status, 'cancelled');
});

test('foreground failure summary does not render a partial conclave package', () => {
  const out = renderConclaveForeground({ id: 'conc-test', status: 'failed', errorCode: 'coordinator_error', errorMessage: 'event write failed' });
  assert.match(out, /Status:\*\* failed/);
  assert.match(out, /Código:\*\* coordinator_error/);
  assert.match(out, /Erro:\*\* event write failed/);
  assert.doesNotMatch(out, /Síntese|Rodadas|Válidos/);
});
