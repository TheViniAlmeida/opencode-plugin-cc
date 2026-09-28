import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createJob, readJob, updateJob, spawnWorker } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { run as runWorker } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { spawnDetached } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

test('gate 1: persisted records redact the entire copy without mutating the caller', async (t) => {
  const dir = trackTempDir(t, makeTempDir());
  const secret = 'fake-gate-record-secret';
  registerSecret(secret);
  const request = { parts: [{ type: 'text', text: `prompt ${secret}` }] };
  const job = await createJob(dir, { kind: 'task', summary: secret, request });
  const file = join(dir, 'jobs', `${job.id}.json`);
  assert.equal(readFileSync(file, 'utf8').includes(secret), false);
  assert.equal(request.parts[0].text, `prompt ${secret}`);
  await updateJob(dir, job.id, { status: 'completed', result: { finalText: secret }, errorMessage: secret });
  assert.equal(readFileSync(file, 'utf8').includes(secret), false);
  assert.equal(readJob(dir, job.id).result.finalText, '***');
});

test('gate 1: worker consumes private input once and sends the raw prompt', async (t) => {
  const dir = trackTempDir(t, makeTempDir());
  const secret = 'fake-gate-worker-secret';
  registerSecret(secret);
  const text = `prompt\n  ${secret}\r\n`;
  const job = await createJob(dir, { kind: 'task', request: { parts: [{ type: 'text', text }], statusPollMs: 1, model: { providerID: 'fake', modelID: 'fake' } } });
  const input = join(dir, 'jobs', `${job.id}.input.json`);
  assert.equal(existsSync(input), true);
  assert.equal(statSync(input).mode & 0o777, 0o600);
  let sent;
  const api = {
    async createSession() { return { id: 'ses_gate' }; },
    async promptAsync(id, body) { assert.equal(existsSync(input), false); sent = body; },
    async sessionStatus() { return {}; },
    async children() { return []; },
    async listPermissions() { return []; },
    async listQuestions() { return []; },
    async messages() { return [{ info: { role: 'assistant', parentID: sent.messageID, time: { completed: 1 } }, parts: [{ type: 'text', text: secret }] }]; },
    async diff() { return []; },
  };
  const hub = { async start() {}, stop() {}, track() { return () => {}; }, onReconnect() { return () => {}; } };
  assert.equal(await runWorker({ stateDir: dir, workspaceRoot: dir }, ['--job-id', job.id], {
    ensureServer: async () => ({ url: 'http://unused.invalid' }), createApi: () => api, createHub: () => hub, scheduleExit: () => {},
  }), 0, readJob(dir, job.id).errorMessage);
  assert.equal(sent.parts[0].text, text);
  assert.equal(existsSync(input), false);
  assert.equal(readFileSync(join(dir, 'jobs', `${job.id}.json`), 'utf8').includes(secret), false);
});

test('gate 4: spawn identity failure marks the job failed immediately', async (t) => {
  const dir = trackTempDir(t, makeTempDir());
  const job = await createJob(dir, { kind: 'task', request: { parts: [] } });
  const ctx = { stateDir: dir, workspaceRoot: dir, dataDir: dir, env: process.env };
  await assert.rejects(spawnWorker(ctx, job.id, {
    spawn: async (_command, _args, options) => spawnDetached(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      ...options, readIdentity: () => { throw new Error('identidade indisponível'); }, identityTimeoutMs: 1,
    }),
  }), (err) => err.code === 'WORKER_SPAWN_FAILED');
  const stored = readJob(dir, job.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.errorCode, 'WORKER_SPAWN_FAILED');
  assert.match(stored.errorMessage, /Não foi possível iniciar/);
  assert.equal(existsSync(join(dir, 'jobs', `${job.id}.input.json`)), false);
});

test('gate 1: terminal jobs discard an input that no worker consumed', async (t) => {
  const dir = trackTempDir(t, makeTempDir());
  const job = await createJob(dir, { kind: 'task', request: { parts: [] } });
  await updateJob(dir, job.id, { status: 'cancelled' });
  assert.equal(existsSync(join(dir, 'jobs', `${job.id}.input.json`)), false);
});

for (const failure of ['patch', 'bridge']) {
  test(`gate 3: worker persists abort confirmation after ${failure} failure`, async (t) => {
    const dir = trackTempDir(t, makeTempDir());
    const job = await createJob(dir, { kind: 'task', request: {
      parts: [{ type: 'text', text: 'test' }], model: { providerID: 'fake', modelID: 'fake' },
      profileKind: 'read-only', idleWaitMs: 10,
      childPermission: failure === 'patch' ? [{ permission: '*', pattern: '*', action: 'deny' }] : null,
    } });
    let handler;
    const hub = { async start() {}, stop() {}, track(_id, fn) { handler = fn; return () => {}; }, onReconnect() { return () => {}; } };
    const statuses = { ses_parent: { type: 'busy' }, ses_child: { type: 'busy' } };
    const aborts = [];
    const api = {
      async createSession() { return { id: 'ses_parent' }; },
      async promptAsync() {
        handler({ type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_parent' } } });
        if (failure === 'bridge') handler({ type: 'permission.asked', properties: { id: 'per_gate', sessionID: 'ses_child', permission: 'bash' } });
      },
      async patchSession() { throw new Error('falha no PATCH'); },
      async replyPermission() { throw new Error('falha na ponte'); },
      async abort(id) { aborts.push(id); delete statuses[id]; return true; },
      async sessionStatus() { return statuses; },
      async messages() { return []; },
      async diff() { return []; },
    };
    await runWorker({ stateDir: dir, workspaceRoot: dir }, ['--job-id', job.id], {
      ensureServer: async () => ({ url: 'http://unused.invalid' }), createApi: () => api,
      createHub: () => hub, scheduleExit: () => {},
    });
    const stored = readJob(dir, job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.errorCode, failure === 'patch' ? 'CHILD_PERMISSION_FAILED' : 'CALLBACK_FAILED');
    assert.equal(stored.result.abortConfirmed, true);
    assert.deepEqual(aborts, ['ses_child', 'ses_parent']);
    assert.deepEqual(stored.result.sessionAborts.map(({ idle }) => idle), [true, true]);
  });
}
