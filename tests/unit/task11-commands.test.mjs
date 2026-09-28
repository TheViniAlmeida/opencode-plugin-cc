import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, updateJob, readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { run as runStatus } from '../../plugins/opc/scripts/commands/status.mjs';
import { run as runResult } from '../../plugins/opc/scripts/commands/result.mjs';
import { run as runCancel } from '../../plugins/opc/scripts/commands/cancel.mjs';
import { deadPid, makeTempDir, trackTempDir } from '../helpers.mjs';

function context(t) {
  const stateDir = trackTempDir(t, makeTempDir('opc-task11-'));
  const output = { out: '', err: '', json: null };
  return { stateDir, claudeSessionId: 'claude-test', env: {}, output,
    out: (text) => { output.out += text; }, err: (text) => { output.err += text; }, json: (value) => { output.json = value; } };
}

for (const [name, run] of [['status', runStatus], ['result', runResult], ['cancel', runCancel]]) {
  test(`${name} rejects extra positional arguments with a truncated preview`, async (t) => {
    const ctx = context(t);
    await assert.rejects(run(ctx, ['first', 'extra-argument-value']), (err) => err.exitCode === 2 && err.message.includes('extra-argume…'));
  });
}

test('status rejects negative timeout and polling intervals', async (t) => {
  const ctx = context(t);
  for (const argv of [['task-x', '--timeout-ms', '-1'], ['task-x', '--poll-interval-ms', '-1']]) {
    await assert.rejects(runStatus(ctx, argv), (err) => err.exitCode === 2 && /negativo/.test(err.message));
  }
});

test('result without an id reconciles a dead worker before selecting a result', async (t) => {
  const ctx = context(t);
  const job = await createJob(ctx.stateDir, { kind: 'task', title: 'dead worker', claudeSessionId: ctx.claudeSessionId });
  await updateJob(ctx.stateDir, job.id, { status: 'running', phase: 'running', pid: await deadPid(), pidStartTime: '1' });
  assert.equal(await runResult(ctx, []), 7);
  assert.equal(readJob(ctx.stateDir, job.id).errorCode, 'worker_lost');
});

test('cancel reports CANCEL_FAILED as exit 5 and never renders success', async (t) => {
  const ctx = context(t);
  const job = await createJob(ctx.stateDir, { kind: 'task', title: 'cancel failure', claudeSessionId: ctx.claudeSessionId, sessionID: 'ses123' });
  await updateJob(ctx.stateDir, job.id, { status: 'running', phase: 'running' });
  ctx.env.OPC_SERVER_URL = 'http://127.0.0.1:1';
  const code = await runCancel(ctx, [job.id]);
  assert.equal(code, 5);
  assert.match(ctx.output.err, /Falha ao cancelar.*CANCEL_FAILED/);
  assert.match(ctx.output.err, /CANCEL_FAILED\): .+/);
  assert.doesNotMatch(ctx.output.out, /Cancelada/);
});
