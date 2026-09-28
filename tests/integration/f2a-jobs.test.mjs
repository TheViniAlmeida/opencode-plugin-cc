import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { jobIdFrom, jobIn, jobsIn, opc, requestsTo, setupF2a, stateDirFor, waitFor } from '../helpers.mjs';

async function startBackground(ctx, prompt, extra = []) {
  const r = await opc(ctx, ['task', '--background', '--json', ...extra, prompt]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).jobId;
}

async function waitRunning(ctx, id) {
  return waitFor(() => {
    const job = jobIn(ctx.env, ctx.cwd, id);
    return job?.status === 'running' && job.sessionID ? job : null;
  }, { timeoutMs: 20000, intervalMs: 100, message: `job ${id} running with a session` });
}

test('background → status → status --wait → result', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const bg = await opc(ctx, ['task', '--background', 'in the background']);
  assert.equal(bg.code, 0, bg.stderr);
  assert.match(bg.stdout, /na fila em segundo plano/);
  const id = jobIdFrom(bg.stdout);
  const listed = await opc(ctx, ['status']);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(id));
  const waited = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /Estado: completed/);
  const result = await opc(ctx, ['result', id]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^fake-opencode: ok/);
});

test('result renders the structured output of a finished job', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured' });
  const r = await opc(ctx, ['task', 'give me json']);
  assert.equal(r.code, 0, r.stderr);
  const shown = await opc(ctx, ['result', jobIdFrom(r.stderr)]);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /"verdict": "approve"/);
  const latest = await opc(ctx, ['result']);
  assert.equal(latest.stdout, shown.stdout);
});

test('result prints a >1 MB final text whole', async (t) => {
  const ctx = setupF2a(t, { scenario: 'large-output' });
  const r = await opc(ctx, ['task', '--background', '--json', 'big']);
  const { jobId } = JSON.parse(r.stdout);
  await waitFor(() => jobIn(ctx.env, ctx.cwd, jobId)?.status === 'completed', { timeoutMs: 60000, message: 'large job' });
  const shown = await opc(ctx, ['result', jobId], { timeoutMs: 60000 });
  assert.equal(shown.code, 0);
  assert.ok(shown.stdout.length > 1_000_000);
  assert.match(shown.stdout, /END-OF-LARGE-OUTPUT/);
});

test('status --wait without id is a usage error', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ctx, ['status', '--wait'])).code, 2);
});

test('result of an active job → exit 2 "still running"', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const id = await startBackground(ctx, 'slow one');
  const r = await opc(ctx, ['result', id]);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /JOB_ACTIVE: a tarefa ainda está (na fila|em execução)/);
  const noId = await opc(ctx, ['result']);
  assert.equal(noId.code, 2);
});

test('cancel without id: one active job is cancelled; several → exit 2', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const first = await startBackground(ctx, 'first');
  const job = await waitRunning(ctx, first);
  const one = await opc(ctx, ['cancel']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, new RegExp(`Cancelada ${first}`));
  assert.equal(jobIn(ctx.env, ctx.cwd, first).status, 'cancelled');
  assert.ok(requestsTo(ctx.env, 'POST', `/session/${job.sessionID}/abort`).length >= 1);
  const a = await startBackground(ctx, 'a');
  const b = await startBackground(ctx, 'b');
  const many = await opc(ctx, ['cancel']);
  assert.equal(many.code, 2);
  assert.match(many.stdout + many.stderr, new RegExp(`${a}[\\s\\S]*${b}|${b}[\\s\\S]*${a}`));
  assert.equal((await opc(ctx, ['cancel', a])).code, 0);
  assert.equal((await opc(ctx, ['cancel', b])).code, 0);
});

test('cancel during a slow turn aborts the session and stops the worker', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const id = await startBackground(ctx, 'slow');
  const job = await waitRunning(ctx, id);
  const r = await opc(ctx, ['cancel', id, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, 'cancelled');
  assert.equal(payload.report.aborted, true);
  assert.ok(['exited', 'not-running', 'terminated', 'killed'].includes(payload.report.worker), payload.report.worker);
  await waitFor(() => {
    try {
      process.kill(job.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 20000, intervalMs: 100, message: 'worker exit' });
});

test('stale-worker-pid: a pid whose identity does not match never receives a signal', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => sleeper.kill('SIGKILL'));
  const stateDir = stateDirFor(ctx.env, ctx.cwd);
  const job = await createJob(stateDir, { kind: 'task', title: 'opc task', summary: 'stale', workspaceRoot: ctx.cwd, claudeSessionId: 'claude-f2a', permissionProfile: 'read-only' });
  await updateJob(stateDir, job.id, { status: 'running', pid: sleeper.pid, pidStartTime: '1' });
  const r = await opc(ctx, ['cancel', job.id, '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).report.worker, 'identity-mismatch');
  process.kill(sleeper.pid, 0);
  assert.equal(sleeper.signalCode, null);
});

test('jobs.maxActive refuses a new job with exit 2 and the active list', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow', config: { jobs: { maxActive: 1, maxParallel: 4 } } });
  const first = await startBackground(ctx, 'first');
  const r = await opc(ctx, ['task', '--background', 'second']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /jobs\.maxActive \(1\)/);
  assert.match(r.stdout + r.stderr, new RegExp(first));
});

test('server-dies-mid-turn → failed with server_lost, session kept, --resume hint (exit 7)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'server-dies-mid-turn' });
  const r = await opc(ctx, ['task', 'doomed'], { timeoutMs: 90000 });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stdout, /ServerLost/);
  assert.match(r.stdout, /--resume task-/);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  assert.equal(job.errorCode, 'server_lost');
  assert.match(job.sessionID, /^ses/);
});

test('retry-status → phase retrying in the log, then completed', async (t) => {
  const ctx = setupF2a(t, { scenario: 'retry-status' });
  const r = await opc(ctx, ['task', 'flaky provider']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((r.stderr.match(/\[opc\] Nova tentativa \(1\): APIError 429/g) ?? []).length, 1);
  assert.match(r.stdout, /recovered after retry/);
});

test('session-error-event → failed with the event error (fatal), exit 7', async (t) => {
  const ctx = setupF2a(t, { scenario: 'session-error-event' });
  const r = await opc(ctx, ['task', 'bad credentials']);
  assert.equal(r.code, 7);
  assert.match(r.stdout, /ProviderAuthError \(fatal\): invalid credentials for provider/);
  const [job] = jobsIn(ctx.env, ctx.cwd);
  assert.equal(job.phase, 'failed');
  assert.equal(job.errorClass, 'fatal');
});
