import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { ExitCode } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { cancelForGroup } from '../../plugins/opc/scripts/commands/cancel.mjs';
import { run as runResult, resultForGroupOrCommand } from '../../plugins/opc/scripts/commands/result.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

function state(t) {
  const dir = trackTempDir(t, makeTempDir('opc-task10-'));
  ensurePrivateDir(dir);
  return dir;
}

test('result without an id selects the top-level group aggregate', async (t) => {
  const stateDir = state(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'group', claudeSessionId: 'claude-test' }, [
    { title: 'one', status: 'completed', result: { finalText: 'first' } },
    { title: 'two', status: 'completed', result: { finalText: 'second' } },
  ]);
  await updateJob(stateDir, group.id, { status: 'completed', completedAt: new Date().toISOString() });
  const output = [];
  const ctx = { stateDir, claudeSessionId: 'claude-test', json: (value) => output.push(value), out: () => {} };

  assert.equal(await runResult(ctx, ['--json']), ExitCode.OK);
  assert.equal(output.length, 1);
  assert.equal(output[0].group.id, group.id);
  assert.deepEqual(output[0].members.map((member) => member.id), members.map((member) => member.id));
});

test('result renders a stored terminal cmd job', async (t) => {
  const stateDir = state(t);
  const job = await createJob(stateDir, { kind: 'cmd', title: 'command', request: { command: 'echo', arguments: 'hello' } });
  const terminal = await updateJob(stateDir, job.id, { status: 'completed', result: { command: 'echo', arguments: 'hello', finalText: 'hello' } });
  const output = [];
  const code = resultForGroupOrCommand({ stateDir, json: (value) => output.push(value), out: (value) => output.push(value) }, terminal, {});

  assert.equal(code, ExitCode.OK);
  assert.match(output[0], /hello/);
});

test('cancel group reports failed member ids and returns connection exit code', async (t) => {
  const stateDir = state(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'group', status: 'running' }, [{ title: 'member', status: 'running', sessionID: 'ses_cancel_failure' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  const output = [];
  const ctx = { stateDir, env: { OPC_SERVER_URL: 'http://127.0.0.1:9' }, json: (value) => output.push(value), out: (value) => output.push(value) };

  const code = await cancelForGroup(ctx, group, { json: true });

  assert.equal(code, ExitCode.CONNECTION);
  assert.deepEqual(output[0], {
    group: { ...output[0].group, id: group.id },
    cancelledMembers: [],
    failedMembers: [members[0].id],
    error: 'CANCEL_FAILED',
  });
  assert.equal(output[0].group.status, 'running');
});

test('cancel group reports a failed group abort with CANCEL_FAILED', async (t) => {
  const stateDir = state(t);
  const { group } = await createGroup(stateDir, { kind: 'sub', title: 'group', status: 'running', sessionID: 'ses_group_failure' }, []);
  await updateJob(stateDir, group.id, { status: 'running' });
  const output = [];
  const ctx = { stateDir, env: { OPC_SERVER_URL: 'http://127.0.0.1:9' }, json: (value) => output.push(value), out: (value) => output.push(value) };

  const code = await cancelForGroup(ctx, group, { json: true });

  assert.equal(code, ExitCode.CONNECTION);
  assert.deepEqual(output[0].cancelledMembers, []);
  assert.deepEqual(output[0].failedMembers, []);
  assert.equal(output[0].error, 'CANCEL_FAILED');
  assert.equal(output[0].group.status, 'running');
});

test('successful group cancellation JSON includes an empty failedMembers list', async (t) => {
  const stateDir = state(t);
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'group', status: 'running' }, [{ title: 'member', status: 'running' }]);
  await updateJob(stateDir, group.id, { status: 'running' });
  const output = [];
  const ctx = { stateDir, json: (value) => output.push(value), out: (value) => output.push(value) };

  const code = await cancelForGroup(ctx, group, { json: true });

  assert.equal(code, ExitCode.OK);
  assert.deepEqual(output[0].cancelledMembers, [members[0].id]);
  assert.deepEqual(output[0].failedMembers, []);
  assert.equal(output[0].group.status, 'cancelled');
});

test('result renders a cmd job that failed before its worker wrote a result', async (t) => {
  const stateDir = state(t);
  const job = await createJob(stateDir, { kind: 'cmd', title: 'command', request: { command: 'echo', argumentsPreview: 'a b' } });
  const failed = await updateJob(stateDir, job.id, { status: 'failed', errorCode: 'WORKER_SPAWN_FAILED', errorType: 'WorkerSpawnFailed', errorMessage: 'Não foi possível iniciar o worker da tarefa.' });
  const output = [];
  resultForGroupOrCommand({ stateDir, json: (value) => output.push(value), out: (value) => output.push(value) }, failed, {});
  assert.match(output[0], /Status: failed[\s\S]*Erro: WorkerSpawnFailed: Não foi possível iniciar o worker/);
  assert.doesNotMatch(output[0], /sem texto final/);
});
