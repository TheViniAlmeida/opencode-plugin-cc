import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { createJob, isActive, listJobs, serverContext } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { clientFor, ensureServer, serverMatcher, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { writeFileAtomic } from '../../plugins/opc/scripts/lib/state.mjs';
import {
  deadPid, makeServerCtx, processAlive, readFakeState, readJsonFile, runCli, spawnSleeper, waitFor,
} from '../helpers.mjs';

test('ensureServer spawns a detached server, records it (600) and reuses it; stopServer identity-stops without dispose', async (t) => {
  const { env, ctx, stateDir } = makeServerCtx(t);
  const first = await ensureServer(ctx);
  assert.equal(first.reused, false);
  assert.equal(first.attached, false);
  assert.notEqual(first.port, 4096);
  assert.equal(first.url, `http://127.0.0.1:${first.port}`);
  assert.equal(first.version, '2.0.22');
  const record = readJsonFile(path.join(stateDir, 'server.json'));
  assert.deepEqual(
    { schemaVersion: record.schemaVersion, pid: record.pid, port: record.port, spawnedBy: record.spawnedBy, version: record.version, password: record.password },
    { schemaVersion: 1, pid: first.pid, port: first.port, spawnedBy: 'opc', version: '2.0.22', password: first.password },
  );
  assert.equal(record.password.length, 48);
  assert.ok(serverMatcher(first.port)(record.cmdline));
  assert.equal(record.startTime, getProcessIdentity(first.pid).startTime);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(stateDir, 'server.json')).mode & 0o777, 0o600);

  const second = await ensureServer(ctx);
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(readFakeState(env).bootAttempts, 1);

  writeFileAtomic(path.join(stateDir, 'server.json'), { ...record, startTime: `${record.startTime}-mismatch` });
  try {
    assert.deepEqual(await stopServer(ctx), { stopped: false, reason: 'identity-mismatch' });
    assert.ok(processAlive(first.pid), 'a mismatched identity must not be terminated');
    assert.equal(readFakeState(env).signals.length, 0, 'no signal for a mismatched identity');
  } finally {
    writeFileAtomic(path.join(stateDir, 'server.json'), record);
  }

  assert.deepEqual(await stopServer(ctx), { stopped: true, reason: 'terminated' });
  await waitFor(() => !processAlive(first.pid), { message: 'server gone' });
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
  const fake = readFakeState(env);
  assert.equal(fake.requests.some((r) => r.path === '/global/dispose'), false, 'stop never sends dispose');
  assert.ok(fake.signals.some((s) => s.signal === 'SIGTERM' && s.pid === record.pid), 'the identity-matched process receives SIGTERM');
  assert.deepEqual(await stopServer(ctx), { stopped: false, reason: 'not-running' });
});

test('concurrent ensureServer calls in one process produce a single spawn', async (t) => {
  const { env, ctx } = makeServerCtx(t);
  const [a, b] = await Promise.all([ensureServer(ctx), ensureServer(ctx)]);
  assert.equal(a.pid, b.pid);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
  assert.equal(readFakeState(env).bootAttempts, 1);
});

test('stale-server-pid: a record pointing to a foreign live process is discarded without any signal', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t);
  const sleeper = spawnSleeper(t);
  writeFileAtomic(path.join(stateDir, 'server.json'), {
    schemaVersion: 1, pid: sleeper.pid, startTime: getProcessIdentity(sleeper.pid).startTime, port: 45678,
    url: 'http://127.0.0.1:45678', version: '2.0.22', spawnedBy: 'opc',
  });
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.ok(server.warnings.some((w) => /descartado/.test(w)));
  assert.ok(processAlive(sleeper.pid), 'foreign process was not signaled');
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, server.pid);
  assert.deepEqual(await stopServer({ ...ctx }), { stopped: true, reason: 'terminated' });
  writeFileAtomic(path.join(stateDir, 'server.json'), {
    schemaVersion: 1, pid: sleeper.pid, startTime: getProcessIdentity(sleeper.pid).startTime, port: 45678,
    url: 'http://127.0.0.1:45678', version: '2.0.22', password: 'stale-password-0123456789', spawnedBy: 'opc',
  });
  assert.deepEqual(await stopServer(ctx), { stopped: false, reason: 'identity-mismatch' });
  assert.ok(processAlive(sleeper.pid));
});

test('record without password: an owned live server is identity-stopped and replaced', async (t) => {
  const { env, ctx, stateDir } = makeServerCtx(t);
  const first = await ensureServer(ctx);
  const record = readJsonFile(path.join(stateDir, 'server.json'));
  delete record.password;
  writeFileAtomic(path.join(stateDir, 'server.json'), record);

  const replacement = await ensureServer(ctx);
  assert.equal(replacement.reused, false);
  assert.notEqual(replacement.pid, first.pid);
  assert.notEqual(replacement.port, first.port);
  await waitFor(() => !processAlive(first.pid), { message: 'unusable owned server terminated' });
  assert.ok(readFakeState(env).signals.some((signal) => signal.pid === first.pid && signal.signal === 'SIGTERM'));
});

test('server-killed-externally: after kill -9 the next ensureServer cleans up and respawns without hanging', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t);
  const first = await ensureServer(ctx);
  process.kill(-first.pid, 'SIGKILL');
  await waitFor(() => !processAlive(first.pid), { message: 'killed' });
  const started = Date.now();
  const second = await ensureServer(ctx);
  assert.ok(Date.now() - started < 15000, 'did not hang');
  assert.equal(second.reused, false);
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.password, first.password);
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, second.pid);
});

test('server-killed-externally (client level): clientFor re-ensures the server and retries a GET', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t);
  const server = await ensureServer(ctx);
  const client = clientFor(ctx, server);
  assert.equal((await client.get('/api/info')).version, '2.0.22');
  process.kill(-server.pid, 'SIGKILL');
  await waitFor(() => !processAlive(server.pid), { message: 'killed' });
  assert.equal((await client.get('/api/info')).version, '2.0.22');
  assert.notEqual(readJsonFile(path.join(stateDir, 'server.json')).pid, server.pid);
  assert.notEqual(client.baseUrl, server.url);
});

test('hung-server: identity ok but health silent → terminated and replaced', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'hung-server' });
  const first = await ensureServer(ctx);
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
  const second = await ensureServer(ctx);
  assert.notEqual(second.pid, first.pid);
  assert.ok(second.warnings.some((w) => /travado/.test(w)));
  await waitFor(() => !processAlive(first.pid), { message: 'hung server gone' });
  assert.ok(readFakeState(env).signals.some((s) => s.signal === 'SIGTERM' && s.pid === first.pid));
});

test('hung server with active write jobs is not killed after three busy health retries', async (t) => {
  const started = performance.now();
  const { env, ctx, stateDir } = makeServerCtx(t, { scenario: 'hung-server' });
  const first = await ensureServer(ctx);
  const job = await createJob(stateDir, { kind: 'task', permissionProfile: 'write' });
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
  const healthCount = () => readFakeState(env).requests.filter((request) => request.path === '/api/info').length;
  const before = healthCount();
  await assert.rejects(ensureServer({ ...ctx, hasActiveJobs: () => listJobs(stateDir, { all: true }).some(isActive) },
    { healthReuseTimeoutMs: 200, healthBusyTimeoutMs: 200 }), (err) => {
    assert.equal(err.name, 'ConnectionError');
    assert.equal(err.code, 'SERVER_UNRESPONSIVE');
    assert.match(err.message, /\/opc:status/);
    assert.match(err.message, /\/opc:cancel/);
    assert.match(err.message, /opc setup --stop-server --force/);
    return true;
  });
  assert.equal(healthCount() - before, 4);
  assert.ok(processAlive(first.pid));
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, first.pid);
  assert.equal(listJobs(stateDir, { all: true }).find((entry) => entry.id === job.id).status, 'queued');
  assert.equal(readFakeState(env).bootAttempts, 1);
  assert.equal(readFakeState(env).signals.length, 0);
  assert.ok(performance.now() - started < 3000, 'injected retry timeouts must keep the test below 3 s');
});

test('setup preserves a hung server when a job is unreadable even without an active index entry', async (t) => {
  const { env, ctx, stateDir, ws } = makeServerCtx(t, { scenario: 'hung-server' });
  const first = await ensureServer(ctx);
  const id = 'task-unreadable-abcdef';
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  const file = path.join(stateDir, 'jobs', `${id}.json`);
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o000);
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
  const result = await runCli(['setup', '--json'], { env, cwd: ws, timeoutMs: 30000 });
  assert.equal(result.code, 5, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.server.error.code, 'SERVER_UNRESPONSIVE');
  assert.match(report.server.error.message, /há 1 job\(s\) ilegível\(is\)/);
  assert.ok(processAlive(first.pid));
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, first.pid);
  assert.equal(readFakeState(env).bootAttempts, 1);
  assert.equal(readFakeState(env).signals.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('a busy hung server that recovers during retries is reused with its world checks', async (t) => {
  const started = performance.now();
  const { env, ctx, stateDir, ws } = makeServerCtx(t, { scenario: 'hung-server' });
  const first = await ensureServer(ctx);
  await createJob(stateDir, { kind: 'task', permissionProfile: 'write' });
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
  const healthCount = () => readFakeState(env).requests.filter((request) => request.path === '/api/info').length;
  const before = healthCount();
  const recovering = ensureServer({ ...ctx, hasActiveJobs: () => listJobs(stateDir, { all: true }).some(isActive) },
    { healthReuseTimeoutMs: 200, healthBusyTimeoutMs: 200 });
  await waitFor(() => healthCount() >= before + 2, { timeoutMs: 10000, intervalMs: 10, message: 'first busy retry' });
  fs.unlinkSync(`${env.FAKE_OPENCODE_STATE}.hang`);
  const reused = await recovering;
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.reused, true);
  assert.equal(reused.world.shareBlocked, false);
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 1);
  assert.equal(fake.signals.length, 0);
  assert.equal(fake.requests.filter((request) => request.path === '/api/config').at(-1).directory, ws);
  assert.equal(healthCount() - before, 3);
  assert.ok(performance.now() - started < 3000, 'injected retry timeouts must keep the test below 3 s');
});

for (const code of ['SERVER_UNRESPONSIVE', 'V1_SERVER_ACTIVE']) {
  test(`${code} explains the unreadable job count and recovery without stopping the server`, async (t) => {
    const { env, ctx, stateDir } = makeServerCtx(t, { scenario: code === 'SERVER_UNRESPONSIVE' ? 'hung-server' : 'version-changed' });
    const first = await ensureServer(ctx);
    for (let index = 0; index < 2; index += 1) {
      const job = await createJob(stateDir, { kind: 'task' });
      fs.chmodSync(path.join(stateDir, 'jobs', `${job.id}.json`), 0o000);
    }
    if (code === 'SERVER_UNRESPONSIVE') fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.hang`, String(first.pid));
    else fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.version`, '1.18.34');
    let stderr = '';
    const jobsDirectory = path.join(stateDir, 'jobs');
    const busyCtx = serverContext({ ...ctx, err: (warning) => { stderr += warning; } });
    await assert.rejects(ensureServer(busyCtx, { healthReuseTimeoutMs: 200, healthBusyTimeoutMs: 200 }), (error) => {
      assert.equal(error.code, code);
      assert.ok(error.message.includes(`há 2 job(s) ilegível(is) em ${jobsDirectory}; corrija as permissões ou use /opc:setup --stop-server --force`));
      assert.deepEqual(error.details, { unreadableJobCount: 2, jobsDir: jobsDirectory });
      return true;
    });
    assert.equal((stderr.match(/\[opc\] aviso:/g) ?? []).length, 2);
    assert.ok(processAlive(first.pid));
    assert.equal(readJsonFile(path.join(stateDir, 'server.json')).pid, first.pid);
    assert.equal(readFakeState(env).bootAttempts, 1);
    assert.equal(readFakeState(env).signals.length, 0);
  });
}

test('version-changed: reused with a warning while jobs are active, replaced when idle', async (t) => {
  const { env, ctx, stateDir } = makeServerCtx(t, { scenario: 'version-changed' });
  const first = await ensureServer(ctx);
  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.version`, '2.0.23');
  const busy = await ensureServer({ ...ctx, hasActiveJobs: () => true });
  assert.equal(busy.pid, first.pid);
  assert.equal(busy.reused, true);
  assert.ok(busy.warnings.some((w) => /mudou de versão/.test(w)));
  const idle = await ensureServer(ctx);
  assert.notEqual(idle.pid, first.pid);
  assert.equal(idle.version, '2.0.23');
  assert.ok(idle.warnings.some((w) => /versão mudou/.test(w)));
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).version, '2.0.23');
});

test('stopServer: refuses with active jobs, --force requires confirmation, attach mode is never stopped', async (t) => {
  const { ctx } = makeServerCtx(t);
  const server = await ensureServer(ctx);
  const busyCtx = { ...ctx, hasActiveJobs: () => true };
  assert.deepEqual(await stopServer(busyCtx), { stopped: false, reason: 'active-jobs' });
  assert.ok(processAlive(server.pid));
  await assert.rejects(stopServer(busyCtx, { force: true }), (e) => e.code === 'CONFIRMATION_REQUIRED' && e.exitCode === 2);
  assert.deepEqual(await stopServer(busyCtx, { force: true, confirmedByUser: true }), { stopped: true, reason: 'terminated' });
  assert.deepEqual(await stopServer({ ...ctx, env: { ...ctx.env, OPC_SERVER_URL: 'http://127.0.0.1:1' } }), { stopped: false, reason: 'attached' });
});

test('ignores-sigterm: stopServer escalates to SIGKILL on the group', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'ignores-sigterm' });
  const server = await ensureServer(ctx);
  assert.deepEqual(await stopServer(ctx), { stopped: true, reason: 'killed' });
  await waitFor(() => !processAlive(server.pid), { message: 'killed' });
  assert.ok(readFakeState(env).signals.some((s) => s.signal === 'SIGTERM'));
});

test('stale-lock: an orphan server.lock is broken and ensureServer proceeds', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t);
  fs.writeFileSync(path.join(stateDir, 'server.lock'), JSON.stringify({ pid: await deadPid(), startTime: '1', purpose: 'ghost', token: 'x' }));
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.equal(fs.readdirSync(stateDir).filter((n) => n.startsWith('server.lock.stale-')).length, 1);
});

test('the spawned server receives the password, override and OPC_INSIDE_SERVER; warm-up hits V2 catalogs', async (t) => {
  const { env, ctx, ws } = makeServerCtx(t, { config: { server: { configOverride: { share: 'disabled', small_model: 'p/small' } } } });
  await ensureServer(ctx);
  const fake = readFakeState(env);
  const boot = fake.boots[0];
  assert.deepEqual(
    { insideServer: boot.insideServer, hasPassword: boot.hasPassword, username: boot.username, hostname: boot.hostname, cwd: boot.cwd },
    { insideServer: '1', hasPassword: true, username: null, hostname: '127.0.0.1', cwd: ws },
  );
  assert.deepEqual(JSON.parse(boot.configContent), { share: 'disabled', small_model: 'p/small' });
  assert.ok(fake.requests.some((r) => r.path === '/api/agent' && r.directory === ws));
  assert.ok(fake.requests.some((r) => r.path === '/api/model'));
});
