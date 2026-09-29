import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createJob, readJob, updateJob, resolveJobRef, reconcileJob, jobLogPath,
  GROUP_ROLE, isGroupMember, topLevelJobs, countsTowardLimit, selectJobsToPrune, addGroupMember, createGroup, listGroupMembers,
  aggregateGroup, refreshGroup, cancelJob, cancelGroup, runWithConcurrency,
} from '../../plugins/opc/scripts/lib/jobs.mjs';
import { createRequestBridge, createSerialUpdater } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

function tmpState(t) {
  const dir = trackTempDir(t, makeTempDir('opc-groups-'));
  ensurePrivateDir(dir);
  return dir;
}

test('member helpers: isGroupMember, topLevelJobs, countsTowardLimit', () => {
  const jobs = [
    { id: 'g', role: GROUP_ROLE, groupId: null, status: 'running' },
    { id: 'm1', role: 'member:1', groupId: 'g', status: 'running' },
    { id: 't', status: 'completed' },
  ];
  assert.deepEqual(jobs.filter(isGroupMember).map((j) => j.id), ['m1']);
  assert.deepEqual(topLevelJobs(jobs).map((j) => j.id), ['g', 't']);
  assert.deepEqual(jobs.filter(countsTowardLimit).map((j) => j.id), ['g']);
});

test('selectJobsToPrune: a group counts as one and drops its members with it', () => {
  const jobs = [
    { id: 'old-g', role: GROUP_ROLE, status: 'completed', completedAt: '2026-01-01' },
    { id: 'old-m1', groupId: 'old-g', status: 'completed', completedAt: '2026-01-01' },
    { id: 'new-t', status: 'failed', completedAt: '2026-09-01' },
    { id: 'active', status: 'running' },
  ];
  assert.deepEqual(selectJobsToPrune(jobs, 1).sort(), ['old-g', 'old-m1']);
  assert.deepEqual(selectJobsToPrune(jobs, 2), []);
});

test('createGroup: group + ordered members with groupId, roles and memberIds', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'OPC: subagents: x', workspaceRoot: '/ws', claudeSessionId: 'c1', request: { prompt: 'private' } }, [
    { title: 'a', agent: 'general', model: 'p/a', memberIndex: 0 },
    { title: 'b', agent: 'general', model: 'p/b', memberIndex: 1 },
  ]);
  assert.equal(group.role, GROUP_ROLE);
  assert.deepEqual(group.memberIds, members.map((m) => m.id));
  assert.deepEqual(members.map((m) => [m.groupId, m.role, m.kind, m.status]), [[group.id, 'member:1', 'sub', 'queued'], [group.id, 'member:2', 'sub', 'queued']]);
  assert.deepEqual(listGroupMembers(stateDir, group.id).map((m) => m.model), ['p/a', 'p/b']);
  assert.deepEqual(members.map((m) => m.memberIndex), [0, 1]);
  assert.ok(members.every((m) => m.request == null));
  assert.deepEqual(readdirSync(join(stateDir, 'jobs')).filter((name) => name.endsWith('.input.json')), [`${group.id}.input.json`]);
});

test('addGroupMember: on-demand member appended to memberIds; own kind and status honoured', async (t) => {
  const stateDir = tmpState(t);
  const { group } = await createGroup(stateDir, { kind: 'sub', title: 'g', workspaceRoot: '/ws' }, []);
  assert.deepEqual(group.memberIds, []);
  const a = await addGroupMember(stateDir, group.id, { title: 'a' });
  const b = await addGroupMember(stateDir, group.id, { title: 'b', kind: 'cmd', role: 'planner', status: 'running' });
  assert.deepEqual([a.kind, a.role, a.status, a.groupId, a.workspaceRoot], ['sub', 'member:1', 'queued', group.id, '/ws']);
  assert.deepEqual([b.kind, b.role, b.status], ['cmd', 'planner', 'running']);
  assert.deepEqual(readJob(stateDir, group.id).memberIds, [a.id, b.id]);
  await assert.rejects(addGroupMember(stateDir, a.id, { title: 'x' }), (e) => e.code === 'NOT_FOUND');
});

test('aggregateGroup: waiting > running > completed(with warnings) > failed > cancelled', () => {
  const s = (...statuses) => statuses.map((status) => ({ status }));
  assert.equal(aggregateGroup(s('running', 'waiting_permission')).status, 'waiting_permission');
  assert.equal(aggregateGroup(s('completed', 'running')).status, 'running');
  assert.equal(aggregateGroup(s('queued', 'queued')).status, 'queued');
  const partial = aggregateGroup(s('completed', 'failed', 'cancelled'));
  assert.equal(partial.status, 'completed');
  assert.equal(partial.phase, '3/3 concluídas');
  assert.deepEqual(partial.warnings, ['1 falharam, 1 canceladas']);
  assert.equal(aggregateGroup(s('failed', 'cancelled')).status, 'failed');
  assert.equal(aggregateGroup(s('cancelled', 'cancelled')).status, 'cancelled');
});

test('refreshGroup aggregates members; cancelled group stays cancelled; final forces a terminal state', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { status: 'completed', result: { finalText: 'ok' } });
  let g = await refreshGroup(stateDir, group.id);
  assert.equal(g.status, 'running');
  assert.equal(g.phase, '1/2 concluídas');
  g = await refreshGroup(stateDir, group.id, { final: true });
  assert.equal(g.status, 'failed', 'a member still queued at the end is a coordinator failure');
  // F2a updateJob never changes the status of a terminal job, so stickiness is checked on a fresh group.
  const other = await createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'c' }]);
  await updateJob(stateDir, other.group.id, { status: 'cancelled' });
  await updateJob(stateDir, other.members[0].id, { status: 'completed' });
  assert.equal((await refreshGroup(stateDir, other.group.id)).status, 'cancelled');
});

test('non-final refresh keeps completed group open for on-demand members', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g', status: 'running' }, [{ title: 'a' }]);
  await updateJob(stateDir, members[0].id, { status: 'completed', result: { finalText: 'first' } });

  let refreshed = await refreshGroup(stateDir, group.id);
  assert.equal(refreshed.status, 'running');
  assert.equal(refreshed.completedAt, null);
  assert.equal(refreshed.phase, '1/1 concluídas');
  assert.deepEqual(refreshed.result.counts, { queued: 0, running: 0, waiting_permission: 0, completed: 1, failed: 0, cancelled: 0 });

  const next = await addGroupMember(stateDir, group.id, { title: 'next' });
  assert.deepEqual(readJob(stateDir, group.id).memberIds, [members[0].id, next.id]);
  assert.deepEqual(listGroupMembers(stateDir, group.id).map((member) => member.id), [members[0].id, next.id]);

  await updateJob(stateDir, next.id, { status: 'completed', result: { finalText: 'second' } });
  refreshed = await refreshGroup(stateDir, group.id, { final: true });
  assert.equal(refreshed.status, 'completed');
  assert.ok(refreshed.completedAt);
});

test('cancelGroup reports failed member cancels and leaves the group active', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g', status: 'running' }, [{ title: 'a', status: 'running' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { sessionID: 'ses_cancel_failure' });

  // file: URLs are rejected by fetch before any network connection, exercising cancelJob's
  // non-throwing CANCEL_FAILED result deterministically.
  const ctx = { stateDir, env: { OPC_SERVER_URL: 'file:///tmp/opc-cancel-test' } };
  const firstCancel = await cancelJob(ctx, members[0].id);
  assert.equal(firstCancel.ok, false);
  assert.equal(firstCancel.code, 'CANCEL_FAILED');
  const result = await cancelGroup(ctx, group.id);

  assert.deepEqual(result.cancelledMembers, []);
  assert.deepEqual(result.failedMembers, [members[0].id]);
  assert.equal(result.group.status, 'running');
  assert.equal(readJob(stateDir, members[0].id).status, 'running');
  const log = readFileSync(jobLogPath(stateDir, group.id), 'utf8');
  assert.match(log, new RegExp(`cancel ${members[0].id} falhou: .+`));
  assert.doesNotMatch(log, /ses_cancel_failure/);
});

test('refreshGroup final writes decorate() fields in the terminal update', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { status: 'completed' });
  const g = await refreshGroup(stateDir, group.id, { final: true, decorate: (grp, ms) => ({ rendered: `${grp.status} ${ms.length}` }) });
  assert.equal(g.status, 'completed');
  assert.equal(readJob(stateDir, group.id).rendered, 'completed 1');
});

test('maxActive counts a group as one job', async (t) => {
  const stateDir = tmpState(t);
  await createGroup(stateDir, { kind: 'sub', title: 'g', status: 'running' }, Array.from({ length: 6 }, (_, i) => ({ title: `m${i}`, status: 'running' })));
  // 1 group + 7 tasks = 8 top-level active jobs (the default maxActive); the 6 members do not count.
  for (let i = 0; i < 7; i += 1) await createJob(stateDir, { kind: 'task', title: `t${i}`, status: 'running' });
  await assert.rejects(createJob(stateDir, { kind: 'task', title: 'one too many', status: 'running' }), (e) => e.code === 'TOO_MANY_JOBS');
});

test('members are never refused by maxActive (the group already took its slot)', async (t) => {
  const stateDir = tmpState(t);
  for (let i = 0; i < 7; i += 1) await createJob(stateDir, { kind: 'task', title: `t${i}` });
  // 7 active + the group = 8 (the default maxActive): the group fits, and so do all its members.
  const { members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
  assert.equal(members.length, 3);
  const groupId = members[0].groupId;
  assert.ok(await addGroupMember(stateDir, groupId, { title: 'd' }));
  await assert.rejects(createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'x' }]), (e) => e.code === 'TOO_MANY_JOBS');
  await assert.rejects(createJob(stateDir, { kind: 'task', title: 'one too many' }, { maxActive: 8 }), (e) => e.code === 'TOO_MANY_JOBS');
});

const LONG_AGO = '2020-01-01T00:00:00.000Z';

test('a member is never worker_lost while its group lives', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  // member a: queued, no pid, created long ago (a top-level job would be lost after 60 s);
  // member b: pid of a process whose cmdline is not "task-worker --job-id <b>" (e.g. the inherited coordinator pid).
  await updateJob(stateDir, members[0].id, { createdAt: LONG_AGO });
  await updateJob(stateDir, members[1].id, { status: 'running', pid: process.pid, pidStartTime: null });
  for (const m of members) assert.ok(['queued', 'running'].includes((await reconcileJob(stateDir, readJob(stateDir, m.id))).status));
  await createJob(stateDir, { kind: 'task', title: 'triggers the createJob sweep' });
  assert.deepEqual(listGroupMembers(stateDir, group.id).map((m) => m.errorCode), [null, null]);
});

test('a lost group takes its active members down (reconcileJob and the createJob sweep)', async (t) => {
  const stateDir = tmpState(t);
  const one = await createGroup(stateDir, { kind: 'sub', title: 'g1' }, [{ title: 'a' }, { title: 'b' }]);
  const two = await createGroup(stateDir, { kind: 'sub', title: 'g2' }, [{ title: 'c' }]);
  await updateJob(stateDir, one.members[1].id, { status: 'completed' });
  for (const g of [one.group, two.group]) await updateJob(stateDir, g.id, { createdAt: LONG_AGO });
  const lost = await reconcileJob(stateDir, readJob(stateDir, one.group.id));
  assert.equal(lost.errorCode, 'worker_lost');
  assert.deepEqual(listGroupMembers(stateDir, one.group.id).map((m) => [m.status, m.errorCode]), [['failed', 'worker_lost'], ['completed', null]]);
  await createJob(stateDir, { kind: 'task', title: 'triggers the createJob sweep' });
  assert.equal(readJob(stateDir, two.group.id).errorCode, 'worker_lost');
  assert.deepEqual(listGroupMembers(stateDir, two.group.id).map((m) => m.errorCode), ['worker_lost']);
});

test('resolveJobRef without ref ignores group members', async (t) => {
  const stateDir = tmpState(t);
  const { group } = await createGroup(stateDir, { kind: 'sub', title: 'g', claudeSessionId: 'c1' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  const resolved = resolveJobRef(stateDir, undefined, { claudeSessionId: 'c1', activeOnly: true });
  assert.equal(resolved.id ?? resolved, group.id);
});

test('runWithConcurrency respects the limit, keeps order and captures rejections', async () => {
  let current = 0;
  let peak = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
    current += 1;
    peak = Math.max(peak, current);
    await new Promise((r) => setTimeout(r, 15));
    current -= 1;
    if (x === 3) throw new Error('boom');
    return x * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[4].value, 50);
});

// The request bridge itself is F2a's (tested in F2a Task 10); here only its use inside a group:
// the member's update is wrapped so every change is reflected in the group.
test('F2a bridge on a member: the group lists the pending requests with memberId and clears them on resolve', async (t) => {
  const stateDir = tmpState(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'g' }, [{ title: 'a' }, { title: 'b' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  await updateJob(stateDir, members[0].id, { status: 'running' });
  const updater = createSerialUpdater(stateDir, members[0].id);
  const bridge = createRequestBridge({
    update: async (patch) => { const job = await updater.update(patch); await refreshGroup(stateDir, group.id); return job; },
    jobId: members[0].id, stateDir,
    api: { replyPermission: async () => {}, rejectQuestion: async () => {} },
    profileKind: 'write', policy: {}, timeoutMs: 60000,
  });
  t.after(() => bridge.dispose());
  await bridge.onPermission({ id: 'per_1', sessionID: 'ses_c', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] });
  await bridge.onQuestion({ id: 'que_1', sessionID: 'ses_c', questions: [{ question: 'Qual?' }] });
  let g = readJob(stateDir, group.id);
  assert.equal(g.status, 'waiting_permission');
  assert.deepEqual(g.pendingRequest.map((r) => [r.type, r.id, r.memberId]), [['permission', 'per_1', members[0].id], ['question', 'que_1', members[0].id]]);
  await bridge.onResolved({ type: 'permission', requestID: 'per_1', sessionID: 'ses_c', outcome: 'once' });
  await refreshGroup(stateDir, group.id);
  assert.deepEqual(readJob(stateDir, group.id).pendingRequest.map((r) => r.id), ['que_1']);
  await bridge.onResolved({ type: 'question', requestID: 'que_1', sessionID: 'ses_c', outcome: 'rejected' });
  await refreshGroup(stateDir, group.id);
  g = readJob(stateDir, group.id);
  assert.equal(g.status, 'running');
  assert.equal(g.pendingRequest, null);
  assert.equal(readJob(stateDir, members[0].id).pendingRequest, null);
});
