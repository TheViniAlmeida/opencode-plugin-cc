import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { run as runWorker } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { connectApi, openApi } from '../../plugins/opc/scripts/lib/context.mjs';
import { createJob, readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ExitCode } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import * as serverLib from '../../plugins/opc/scripts/lib/server.mjs';
import { F3_MODELS, SEED } from '../fixtures/f3-fake.mjs';
import {
  F2A_MODEL, jobIdFrom, jobIn, jobsIn, makeServerCtx, makeWorkspace, opc, readFakeState,
  readJsonFile, requestsTo, runCli, setupF2a, startExternalFake, testEnv,
} from '../helpers.mjs';

const SESSION_BODY = {
  title: 'share guard test',
  permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  model: { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' },
};
const isShareError = (err) => err.code === 'SHARE_AUTO' && err.exitCode === ExitCode.POLICY;

for (const recoveredConfig of ['auto', 'unavailable']) {
  test(`server recovery refreshes the session guard when config becomes ${recoveredConfig}`, async (t) => {
    const external = await startExternalFake(t);
    const { ctx } = makeServerCtx(t, { extraEnv: {
      OPC_SERVER_URL: external.url, OPC_SERVER_PASSWORD: external.password,
    } });
    const fetchImpl = globalThis.fetch;
    let recover = false;
    let failedGet = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const route = new URL(url).pathname;
      if (recover && route === '/api/session' && init.method === 'GET' && !failedGet) {
        failedGet = true;
        throw Object.assign(new Error('synthetic disconnect'), { code: 'ECONNRESET' });
      }
      if (recover && route === '/api/config' && recoveredConfig === 'unavailable') {
        return new Response('[]', { headers: { 'content-type': 'application/json' } });
      }
      return fetchImpl(url, init);
    });
    const { api, server } = await connectApi(ctx);
    assert.equal(server.world.shareBlocked, false);
    recover = true;
    if (recoveredConfig === 'auto') external.fake.configOverride = { share: 'auto' };
    await api.listSessions();
    assert.equal(failedGet, true);
    await assert.rejects(() => api.createSession(SESSION_BODY), isShareError);
    await assert.rejects(() => api.fork(SEED.session), isShareError);
    assert.equal(server.world.shareBlocked, true);
    assert.equal(server.world.shareReason, recoveredConfig === 'auto' ? 'share-auto' : 'config-unavailable');
    assert.equal(readJsonFile(external.stateFile).requests.filter((r) => r.method === 'POST').length, 0);
  });
}

for (const [scenario, reason, message] of [
  ['share-auto', 'share-auto', /share "auto"/],
  ['config-unavailable-recover', 'config-unavailable', /configuração de compartilhamento/],
]) {
  for (const background of [false, true]) {
    test(`task refuses ${reason} before queuing${background ? ' in background' : ''}`, async (t) => {
      const ctx = setupF2a(t, { scenario, git: false });
      const result = await opc(ctx, ['task', '--model', F2A_MODEL, ...(background ? ['--background'] : []), 'oi']);
      assert.equal(result.code, ExitCode.POLICY, result.stderr);
      assert.match(result.stderr, /SHARE_AUTO/);
      assert.match(result.stderr, message);
      assert.deepEqual(jobsIn(ctx.env, ctx.cwd), []);
      assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
    });
  }
}

for (const argv of [
  ['command', 'init'],
  ['subagent', '--agent', 'general', '--model', F2A_MODEL, 'oi'],
  ['conclave', '--models', `${F2A_MODEL},${F3_MODELS.qwen}`, 'oi'],
  ['orchestrate', '--planner', F2A_MODEL, 'oi'],
]) {
  test(`${argv[0]} refuses share auto before queuing a job`, async (t) => {
    const ctx = setupF2a(t, { scenario: 'share-auto', git: false });
    const result = await opc(ctx, argv);
    assert.equal(result.code, ExitCode.POLICY, result.stderr);
    assert.match(result.stderr, /SHARE_AUTO/);
    assert.match(result.stderr, /share "auto"/);
    assert.deepEqual(jobsIn(ctx.env, ctx.cwd), []);
    assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
  });
}

test('task resume remains allowed with share auto without creating a session', async (t) => {
  const external = await startExternalFake(t);
  external.fake.configOverride = { share: 'auto' };
  const ctx = setupF2a(t, { git: false, extraEnv: {
    OPC_SERVER_URL: external.url, OPC_SERVER_PASSWORD: external.password,
  } });
  external.fake.state.sessions[SEED.session].location.directory = ctx.cwd;
  const result = await opc(ctx, ['task', '--resume', SEED.session, '--model', F2A_MODEL, 'continue']);
  assert.equal(result.code, ExitCode.OK, result.stderr);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(result.stderr));
  assert.equal(job.status, 'completed');
  assert.equal(job.sessionID, SEED.session);
  const requests = readJsonFile(external.stateFile).requests;
  assert.equal(requests.filter((r) => r.method === 'POST' && r.path === '/api/session').length, 0);
  assert.equal(requests.filter((r) => r.method === 'POST' && r.path === `/api/session/${SEED.session}/prompt`).length, 1);
});

test('read-only models command still works with share auto', async (t) => {
  const env = testEnv(t, { scenario: 'share-auto' });
  const ws = makeWorkspace(t, { git: false });
  const result = await runCli(['models', '--json'], { env, cwd: ws });
  assert.equal(result.code, ExitCode.OK, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.match(result.stderr, /share "auto"/);
  assert.equal(requestsTo(env, 'POST', '/api/session').length, 0);
});

for (const [name, connect] of [
  ['connectApi', connectApi],
  ['openApi without respawn', (ctx) => openApi(ctx, { respawn: false })],
]) {
  for (const scenario of ['share-auto', 'config-unavailable-recover']) {
    test(`${name} guards both createSession and fork with ${scenario}`, async (t) => {
      const { ctx, env } = makeServerCtx(t, { scenario });
      const { api, server } = await connect(ctx);
      assert.equal(server.world.shareBlocked, true);
      assert.equal(server.world.shareReason, scenario === 'share-auto' ? 'share-auto' : 'config-unavailable');
      await assert.rejects(async () => api.createSession(SESSION_BODY), isShareError);
      await assert.rejects(async () => api.fork(SEED.session), isShareError);
      assert.equal(readFakeState(env).requests.filter((r) => r.method === 'POST').length, 0);
      assert.ok((await api.models()).length > 0, 'discovery stays available');
    });
  }

  for (const share of ['manual', 'disabled']) {
    test(`${name} delegates createSession and fork with share ${share}`, async (t) => {
      const { ctx, env } = makeServerCtx(t, { scenario: 'f3-sessions', config: { server: { configOverride: { share } } } });
      const { api, server } = await connect(ctx);
      assert.equal(server.world.shareBlocked, false);
      const created = await api.createSession(SESSION_BODY);
      const forked = await api.fork(created.id);
      assert.notEqual(forked.id, created.id);
      assert.equal(requestsTo(env, 'POST', '/api/session').length, 1);
      assert.equal(requestsTo(env, 'POST', `/api/session/${created.id}/fork`).length, 1);
    });
  }
}

test('guardSessionCreation preserves other methods, arguments, return values and method receivers', async () => {
  const calls = [];
  const api = {
    marker: 'api',
    info() { return this.marker; },
    createSession(...args) { calls.push(['create', this, args]); return 'created'; },
    fork(...args) { calls.push(['fork', this, args]); return 'forked'; },
  };
  const server = { world: { shareBlocked: false } };
  const guarded = serverLib.guardSessionCreation(api, server);
  assert.deepEqual(Object.keys(guarded).sort(), Object.keys(api).sort());
  assert.equal(guarded.info, api.info);
  assert.equal(guarded.info(), 'api');
  assert.equal(await guarded.createSession(SESSION_BODY), 'created');
  assert.equal(await guarded.fork('ses_source', { before: 'msg_boundary' }), 'forked');
  assert.equal(await guarded.createSession.call({ marker: 'other' }, SESSION_BODY), 'created');
  assert.equal(await guarded.fork.call({ marker: 'other' }, 'ses_source'), 'forked');
  assert.deepEqual(calls, [
    ['create', api, [SESSION_BODY]], ['fork', api, ['ses_source', { before: 'msg_boundary' }]],
    ['create', api, [SESSION_BODY]], ['fork', api, ['ses_source']],
  ]);
  server.world = { shareBlocked: true, shareReason: 'share-auto' };
  await assert.rejects(async () => guarded.createSession(SESSION_BODY), isShareError);
  await assert.rejects(async () => guarded.fork('ses_source'), isShareError);
  assert.equal(calls.length, 4, 'blocked calls never reach the underlying API');
});

for (const mapping of ['local', 'env', 'config']) {
  test(`attach world checks use the same ${mapping} directory as session operations`, async (t) => {
    const { ctx, env, ws } = makeServerCtx(t);
    const external = await startExternalFake(t);
    const directory = mapping === 'local' ? ws : '/srv/share-guard/repo';
    const attachedCtx = {
      ...ctx,
      env: { ...env, OPC_SERVER_URL: external.url, OPC_SERVER_PASSWORD: external.password,
        ...(mapping === 'env' ? { OPC_REMOTE_ROOT: directory } : {}) },
      config: { ...ctx.config, server: { ...ctx.config.server,
        ...(mapping === 'config' ? { remoteRoots: { [ws]: directory } } : {}) } },
    };
    const { api, server } = await connectApi(attachedCtx);
    assert.equal(server.world.shareBlocked, false);
    await api.listSessions();
    const requests = readJsonFile(external.stateFile).requests;
    const configs = requests.filter((r) => r.path === '/api/config');
    assert.ok(configs.length > 0);
    assert.ok(configs.every((r) => r.directory === directory), 'all config reads carry x-opencode-directory');
    assert.equal(requests.find((r) => r.path === '/api/session').directory, directory);
  });
}

for (const versionChanged of [false, true]) {
  test(`reuse world check carries the workspace directory${versionChanged ? ' with active jobs and a changed version' : ''}`, async (t) => {
    const { ctx, env, ws, stateDir } = makeServerCtx(t);
    const first = await serverLib.ensureServer(ctx);
    assert.equal(first.world.shareBlocked, false);
    const requestCount = readFakeState(env).requests.length;
    if (versionChanged) {
      const file = path.join(stateDir, 'server.json');
      fs.writeFileSync(file, JSON.stringify({ ...readJsonFile(file), version: '2.0.23' }));
    }
    const reused = await serverLib.ensureServer({ ...ctx, hasActiveJobs: () => versionChanged });
    assert.equal(reused.reused, true);
    assert.equal(reused.world.shareBlocked, false);
    assert.equal(reused.pid, first.pid);
    const configs = readFakeState(env).requests.slice(requestCount).filter((r) => r.path === '/api/config');
    assert.ok(configs.length > 0);
    assert.ok(configs.every((r) => r.directory === ws), 'reuse config reads carry x-opencode-directory');
  });
}

test('task-worker guards the injected API before attempting to create a session', async (t) => {
  const { ctx } = makeServerCtx(t);
  const job = await createJob(ctx.stateDir, { kind: 'task', request: {
    newSession: { title: SESSION_BODY.title, permissions: SESSION_BODY.permissions },
    model: { providerID: SESSION_BODY.model.providerID, modelID: SESSION_BODY.model.id },
    parts: [{ type: 'text', text: 'oi' }],
  } });
  let creates = 0;
  const code = await runWorker(ctx, ['--job-id', job.id], {
    ensureServer: async () => ({ url: 'http://127.0.0.1:1', world: { shareBlocked: true, shareReason: 'share-auto' } }),
    createApi: () => ({ createSession: async () => { creates += 1; throw new Error('unguarded createSession'); } }),
    createHub: () => ({ async start() {}, stop() {} }),
    scheduleExit() {},
  });
  assert.equal(code, ExitCode.JOB_FAILED);
  assert.equal(readJob(ctx.stateDir, job.id).errorType, 'SHARE_AUTO');
  assert.equal(creates, 0);
});
