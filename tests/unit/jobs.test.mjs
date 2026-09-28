import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_STATUSES, MAX_TERMINAL_JOBS, appendJobLog, cancelJob, createJob, findResumeCandidate, groupStatus, jobLogPath,
  listJobs, newJobId, readJob, readJobProgress, resolveJobRef, updateJob, waitForJob, workerMatcher, acquireSessionLock,
  assertNotInsideServer,
} from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ACTIVE_JOB_STATUSES } from '../../plugins/opc/scripts/lib/state.mjs';

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const base = (over = {}) => ({ kind: 'task', title: 'opc task', summary: 's', workspaceRoot: '/ws', claudeSessionId: 'c1', permissionProfile: 'read-only', ...over });

test('newJobId has the spec format per kind', () => {
  assert.match(newJobId('task'), /^task-[0-9a-z]+-[0-9a-z]{6}$/);
  assert.match(newJobId('adversarial-review'), /^review-/);
  assert.match(newJobId('subagent'), /^sub-/);
  assert.match(newJobId('stop-gate'), /^gate-/);
  const ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
  const prefixes = { sub: 'sub', cmd: 'cmd', orchestrate: 'orch', orch: 'orch', conclave: 'conc', 'conclave-member': 'conc', 'conclave-judge': 'conc' };
  for (const [kind, prefix] of Object.entries(prefixes)) {
    const id = newJobId(kind);
    assert.ok(id.startsWith(`${prefix}-`), `${kind} → ${id}`);
    assert.match(id, ID_RE);
  }
  assert.throws(() => newJobId('nope'), (e) => e.code === 'UNKNOWN_KIND');
});

test('ACTIVE_STATUSES is the F0 ACTIVE_JOB_STATUSES; assertNotInsideServer refuses OPC_INSIDE_SERVER=1', () => {
  assert.equal(ACTIVE_STATUSES, ACTIVE_JOB_STATUSES);
  assert.doesNotThrow(() => assertNotInsideServer({}));
  assert.doesNotThrow(() => assertNotInsideServer(undefined));
  assert.doesNotThrow(() => assertNotInsideServer({ OPC_INSIDE_SERVER: '0' }));
  assert.throws(() => assertNotInsideServer({ OPC_INSIDE_SERVER: '1' }), (e) => e.code === 'INSIDE_SERVER' && e.exitCode === 4);
});

test('a cmd job id is readable (JOB_ID_RE accepts cmd)', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base({ kind: 'cmd' }));
  assert.match(job.id, /^cmd-/);
  assert.equal(readJob(dir, job.id)?.id, job.id);
});

test('createJob writes a queued record with all spec fields; updateJob merges', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  for (const key of ['id', 'kind', 'title', 'summary', 'workspaceRoot', 'claudeSessionId', 'groupId', 'role', 'status', 'phase', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'pid', 'pidStartTime', 'logFile', 'serverUrlRef', 'sessionID', 'parentSessionID', 'childSessionIDs', 'model', 'attempts', 'agent', 'variant', 'permissionProfile', 'pendingRequest', 'errorCode', 'errorClass', 'errorType', 'errorMessage', 'request', 'result', 'rendered']) {
    assert.ok(key in job, key);
  }
  assert.equal(job.status, 'queued');
  assert.equal((statSync(join(dir, 'jobs', `${job.id}.json`)).mode & 0o777), 0o600);
  const updated = await updateJob(dir, job.id, { status: 'running', phase: 'starting' });
  assert.equal(updated.status, 'running');
  assert.equal(readJob(dir, job.id).phase, 'starting');
  assert.equal(readJob(dir, '../etc/passwd'), null);
});

test('terminal status is frozen (cancel wins over late worker writes)', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  await updateJob(dir, job.id, { status: 'cancelled', phase: 'cancelled' });
  const late = await updateJob(dir, job.id, { status: 'completed', phase: 'done', result: { finalText: 'x' } });
  assert.equal(late.status, 'cancelled');
  assert.equal(late.phase, 'cancelled');
  assert.equal(late.result.finalText, 'x');
});

test('jobs.maxActive refuses new jobs with the active list; SESSION_BUSY per session', async (t) => {
  const dir = stateDir(t);
  await createJob(dir, base({ sessionID: 'ses_a' }), { maxActive: 2 });
  await assert.rejects(createJob(dir, base({ sessionID: 'ses_a' }), { maxActive: 2 }), (e) => e.code === 'SESSION_BUSY' && e.exitCode === 2);
  await createJob(dir, base(), { maxActive: 2 });
  await assert.rejects(createJob(dir, base(), { maxActive: 2 }), (e) => e.code === 'TOO_MANY_JOBS' && e.exitCode === 2 && e.details.active.length === 2);
});

test('queued job without worker for 60 s is reconciled as worker_lost', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  const record = readJob(dir, job.id);
  record.createdAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(join(dir, 'jobs', `${job.id}.json`), JSON.stringify(record));
  await createJob(dir, base(), { maxActive: 1 });
  assert.equal(readJob(dir, job.id).errorCode, 'worker_lost');
});

test('prune keeps 50 terminal top-level jobs (group = one), never active ones', async (t) => {
  const dir = stateDir(t);
  const active = await createJob(dir, base(), { maxActive: 100 });
  const group = await createJob(dir, base({ kind: 'subagent' }), { maxActive: 100 });
  await updateJob(dir, group.id, { status: 'completed', completedAt: '2000-01-01T00:00:00.000Z' });
  const member = await createJob(dir, base({ kind: 'subagent', groupId: group.id, role: 'worker:1' }), { maxActive: 100 });
  await updateJob(dir, member.id, { status: 'completed', completedAt: '2000-01-01T00:00:00.000Z' });
  for (let i = 0; i < MAX_TERMINAL_JOBS; i += 1) {
    const j = await createJob(dir, base(), { maxActive: 100 });
    await updateJob(dir, j.id, { status: 'completed', completedAt: new Date(Date.now() + i).toISOString() });
  }
  await createJob(dir, base(), { maxActive: 100 });
  const ids = listJobs(dir, { all: true }).map((j) => j.id);
  assert.ok(ids.includes(active.id));
  assert.ok(!ids.includes(group.id));
  assert.ok(!ids.includes(member.id));
  assert.equal(listJobs(dir, { all: true }).filter((j) => j.status === 'completed').length, MAX_TERMINAL_JOBS);
});

test('listJobs filters by Claude session unless all', async (t) => {
  const dir = stateDir(t);
  await createJob(dir, base({ claudeSessionId: 'c1' }));
  await createJob(dir, base({ claudeSessionId: 'c2' }));
  assert.equal(listJobs(dir, { claudeSessionId: 'c1' }).length, 1);
  assert.equal(listJobs(dir, { claudeSessionId: 'c1', all: true }).length, 2);
  assert.equal(listJobs(dir).length, 2);
});

test('resolveJobRef: exact, unique prefix, ambiguous, single active in session, several active', async (t) => {
  const dir = stateDir(t);
  const a = await createJob(dir, base());
  assert.equal(resolveJobRef(dir, a.id).id, a.id);
  assert.equal(resolveJobRef(dir, a.id.slice(0, a.id.length - 3)).id, a.id);
  assert.equal(resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }).id, a.id);
  const b = await createJob(dir, base());
  assert.throws(() => resolveJobRef(dir, 'task-'), (e) => e.code === 'AMBIGUOUS_JOB');
  assert.throws(() => resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }), (e) => e.code === 'MULTIPLE_ACTIVE_JOBS' && e.exitCode === 2);
  await updateJob(dir, a.id, { status: 'completed' });
  await updateJob(dir, b.id, { status: 'completed' });
  assert.throws(() => resolveJobRef(dir, null, { claudeSessionId: 'c1', activeOnly: true }), (e) => e.code === 'NO_ACTIVE_JOB');
  assert.throws(() => resolveJobRef(dir, 'ask-zzz', {}), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => resolveJobRef(dir, '../x', {}), (e) => e.code === 'INVALID_JOB_ID');
});

test('findResumeCandidate: last terminal job of the same kind in this Claude session', async (t) => {
  const dir = stateDir(t);
  const ask = await createJob(dir, base({ kind: 'ask', sessionID: 'ses_ask' }));
  await updateJob(dir, ask.id, { status: 'completed' });
  const task = await createJob(dir, base({ sessionID: 'ses_task' }));
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'c1' }), null);
  await updateJob(dir, task.id, { status: 'failed' });
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'c1' }).sessionID, 'ses_task');
  assert.equal(findResumeCandidate(dir, { kind: 'ask', claudeSessionId: 'c1' }).sessionID, 'ses_ask');
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: null }), null);
  assert.equal(findResumeCandidate(dir, { kind: 'task', claudeSessionId: 'other' }), null);
});

test('appendJobLog caps the log at 5 MB keeping the tail', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  const chunk = 'y'.repeat(1024 * 1024);
  for (let i = 0; i < 6; i += 1) appendJobLog(dir, job.id, `${i}:${chunk}`);
  appendJobLog(dir, job.id, 'LAST LINE');
  const size = statSync(jobLogPath(dir, job.id)).size;
  assert.ok(size <= 5 * 1024 * 1024, `size ${size}`);
  assert.match(readFileSync(jobLogPath(dir, job.id), 'utf8'), /LAST LINE\n$/);
  assert.deepEqual(readJobProgress(dir, job.id, 1), ['LAST LINE']);
});

test('readJobProgress returns the last N progress lines without timestamps', async (t) => {
  const dir = stateDir(t);
  const job = await createJob(dir, base());
  for (const l of ['a', 'b', 'c', 'd', 'e']) appendJobLog(dir, job.id, l);
  assert.deepEqual(readJobProgress(dir, job.id, 4), ['b', 'c', 'd', 'e']);
});

test('groupStatus aggregates members', () => {
  assert.equal(groupStatus([{ status: 'completed' }, { status: 'running' }]), 'running');
  assert.equal(groupStatus([{ status: 'waiting_permission' }, { status: 'running' }]), 'waiting_permission');
  assert.equal(groupStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled');
  assert.equal(groupStatus([{ status: 'failed' }, { status: 'completed' }]), 'completed');
  assert.equal(groupStatus([{ status: 'failed' }, { status: 'cancelled' }]), 'failed');
  assert.deepEqual(ACTIVE_STATUSES, ['queued', 'running', 'waiting_permission']);
});

test('workerMatcher matches only the companion task-worker for that job id', () => {
  const m = workerMatcher('task-abc-123456');
  assert.equal(m(['/usr/bin/node', '/p/scripts/opc-companion.mjs', 'task-worker', '--job-id', 'task-abc-123456']), true);
  assert.equal(m(['/usr/bin/node', '/p/scripts/opc-companion.mjs', 'task-worker', '--job-id', 'task-abc-654321']), false);
  assert.equal(m(['sleep', '30']), false);
});

test('waitForJob returns terminal or waiting_permission, streams log, times out with exit 6', async (t) => {
  const dir = stateDir(t);
  const ctx = { stateDir: dir, env: {} };
  const job = await createJob(dir, base());
  await updateJob(dir, job.id, { status: 'running', pid: null });
  appendJobLog(dir, job.id, 'phase editing');
  const lines = [];
  setTimeout(() => updateJob(dir, job.id, { status: 'completed', phase: 'done' }), 150);
  const done = await waitForJob(ctx, job.id, { pollMs: 20, onLog: (l) => lines.push(l) });
  assert.equal(done.status, 'completed');
  assert.ok(lines.some((l) => l.endsWith('phase editing')));
  const w = await createJob(dir, base());
  await updateJob(dir, w.id, { status: 'waiting_permission', pendingRequest: [{ type: 'permission', id: 'per_1' }] });
  assert.equal((await waitForJob(ctx, w.id, { pollMs: 20 })).status, 'waiting_permission');
  const slow = await createJob(dir, base());
  await updateJob(dir, slow.id, { status: 'running' });
  await assert.rejects(waitForJob(ctx, slow.id, { waitTimeoutMs: 80, pollMs: 20 }), (e) => e.code === 'WAIT_TIMEOUT' && e.exitCode === 6 && e.details.jobId === slow.id);
});

test('cancelJob: aborts the session, never signals a pid whose identity does not match', async (t) => {
  const dir = stateDir(t);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => sleeper.kill('SIGKILL'));
  const job = await createJob(dir, base({ sessionID: 'ses_x' }));
  await updateJob(dir, job.id, { status: 'running', pid: sleeper.pid, pidStartTime: 'bogus' });
  const calls = [];
  const api = { async abort(id) { calls.push(id); return true; }, async sessionStatus() { return {}; } };
  const { job: final, report } = await cancelJob({ stateDir: dir, env: {} }, job.id, { api });
  assert.equal(final.status, 'cancelled');
  assert.deepEqual(calls, ['ses_x']);
  assert.equal(report.worker, 'identity-mismatch');
  assert.equal(sleeper.exitCode, null);
  process.kill(sleeper.pid, 0);
  await assert.rejects(cancelJob({ stateDir: dir, env: {} }, job.id, { api }), (e) => e.code === 'NOT_ACTIVE');
});

test('acquireSessionLock is exclusive and validates the id', (t) => {
  const dir = stateDir(t);
  const release = acquireSessionLock(dir, 'ses_abc');
  assert.equal(typeof release, 'function');
  assert.equal(acquireSessionLock(dir, 'ses_abc'), null);
  release();
  assert.throws(() => acquireSessionLock(dir, '../x'), (e) => e.code === 'INVALID_SESSION_ID');
});
