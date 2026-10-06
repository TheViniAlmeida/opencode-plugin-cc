import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { assertCanCreateSessions, ensureServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import {
  makeServerCtx, makeTempDir, processAlive, readFakeState, readJsonFile, trackTempDir,
} from '../helpers.mjs';

function assertNoLiveBoots(env) {
  for (const boot of readFakeState(env).boots) assert.equal(processAlive(boot.pid), false, `boot pid ${boot.pid} still alive`);
}

test('port-mismatch: the announced port differs → the attempt is killed and a new port is tried', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'port-mismatch' });
  const server = await ensureServer(ctx);
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 2);
  assert.equal(processAlive(fake.boots[0].pid), false, 'mismatched boot was terminated');
  assert.equal(server.port, fake.boots[1].requestedPort);
});

test('eaddrinuse: two failed boots then success on the third attempt', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'eaddrinuse' });
  const server = await ensureServer(ctx);
  assert.equal(server.reused, false);
  assert.equal(readFakeState(env).bootAttempts, 3);
});

test('eaddrinuse on every attempt → BOOT_FAILED after exactly 3 attempts', async (t) => {
  const { env, ctx, stateDir } = makeServerCtx(t, { scenario: 'eaddrinuse', extraEnv: { FAKE_FAIL_BOOTS: '9' } });
  await assert.rejects(ensureServer(ctx), (e) => {
    assert.equal(e.code, 'BOOT_FAILED');
    assert.equal(e.exitCode, 5);
    assert.match(e.message, /3 tentativas/);
    assert.match(e.message, /EADDRINUSE/);
    return true;
  });
  assert.equal(readFakeState(env).bootAttempts, 3);
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
});

test('boot-slow: timeout on each attempt → BOOT_FAILED without orphans; a longer bootTimeoutSec succeeds', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'boot-slow', extraEnv: { FAKE_BOOT_DELAY_MS: '2500' }, config: { server: { bootTimeoutSec: 0.5 } } });
  let bootError;
  await assert.rejects(ensureServer(ctx), (e) => { bootError = e; return e.code === 'BOOT_FAILED' && /timeout/.test(e.message); });
  // Under load the fake can be killed before it records its own start, so count the plugin's attempts.
  assert.match(bootError.message, /tentativa 3 /);
  assert.doesNotMatch(bootError.message, /tentativa 4 /);
  assert.ok(readFakeState(env).bootAttempts <= 3);
  assertNoLiveBoots(env);
  const patient = { ...ctx, config: mergeConfig({ server: { bootTimeoutSec: 10 } }, null).config };
  const server = await ensureServer(patient);
  assert.equal(server.reused, false);
});

test('version below the minimum → UNSUPPORTED_VERSION; the fresh server is terminated, no retry', async (t) => {
  const { env, ctx, stateDir } = makeServerCtx(t, { scenario: 'old-version' });
  await assert.rejects(ensureServer(ctx), (e) => e.code === 'UNSUPPORTED_VERSION' && e.exitCode === 5);
  assert.equal(readFakeState(env).bootAttempts, 1);
  assertNoLiveBoots(env);
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
});

test('auth-401 → AUTH_FAILED immediately (one boot), server terminated', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'auth-401' });
  await assert.rejects(ensureServer(ctx), (e) => e.code === 'AUTH_FAILED' && e.exitCode === 5);
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 1);
  assert.ok(fake.signals.some((s) => s.signal === 'SIGTERM'));
  assertNoLiveBoots(env);
});

test('missing opencode binary → BOOT_FAILED with install guidance', async (t) => {
  const { ctx } = makeServerCtx(t);
  await assert.rejects(ensureServer({ ...ctx, opencodeBin: 'opencode-missing-binary-xyz' }), (e) => e.code === 'BOOT_FAILED' && /server\.opencodeBin/.test(e.message));
});

test('share-auto: world check marks sessions as blocked and assertCanCreateSessions refuses', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t, { scenario: 'share-auto' });
  const server = await ensureServer(ctx);
  assert.equal(server.world.shareBlocked, true);
  assert.ok(server.warnings.some((w) => /share "auto"/.test(w)));
  assert.throws(() => assertCanCreateSessions(server), (e) => e.code === 'SHARE_AUTO' && e.exitCode === 4);
  assert.equal(readJsonFile(path.join(stateDir, 'server.json')).world.shareBlocked, true);
  const reused = await ensureServer(ctx);
  assert.equal(reused.world.shareBlocked, true, 'block survives reuse');
});

test('world check: default override share:"disabled" keeps sessions allowed; denied model/small_model warn', async (t) => {
  const { ctx } = makeServerCtx(t, { config: { policy: { providers: { deny: ['fake-provider'] } } } });
  const server = await ensureServer(ctx);
  assert.equal(server.world.shareBlocked, false);
  assert.deepEqual(server.world.deniedDefaults, ['model', 'small_model']);
  assert.ok(server.warnings.some((w) => /"model"/.test(w) && /configOverride\.model/.test(w)));
});

test('config unavailable blocks session creation and a later successful reuse check clears the block', async (t) => {
  const { env, ctx } = makeServerCtx(t, { scenario: 'config-unavailable-recover' });
  const first = await ensureServer(ctx);
  assert.equal(first.world.shareBlocked, true);
  assert.equal(first.world.shareReason, 'config-unavailable');
  assert.ok(first.warnings.some((warning) => /GET \/api\/config/.test(warning)));
  assert.throws(() => assertCanCreateSessions(first), (err) => err.code === 'SHARE_AUTO'
    && /tente novamente/i.test(err.message) && /servidor/i.test(err.message));

  fs.writeFileSync(`${env.FAKE_OPENCODE_STATE}.config-ok`, 'ok');
  const reused = await ensureServer(ctx);
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, first.pid);
  assert.equal(reused.world.shareBlocked, false);
  assert.equal(reused.world.shareReason, undefined);
  assert.doesNotThrow(() => assertCanCreateSessions(reused));
});

test('unreadable server.log fails boot with BOOT_FAILED and the filesystem cause', async (t) => {
  const { ctx, stateDir } = makeServerCtx(t, {
    scenario: 'boot-slow',
    extraEnv: { FAKE_BOOT_DELAY_MS: '500' },
    config: { server: { bootTimeoutSec: 3 } },
  });
  const logFile = path.join(stateDir, 'server.log');
  const replaceLog = setTimeout(() => {
    fs.renameSync(logFile, `${logFile}.saved`);
    fs.mkdirSync(logFile);
  }, 100);
  t.after(() => clearTimeout(replaceLog));
  await assert.rejects(ensureServer(ctx), (err) => err.code === 'BOOT_FAILED' && err.exitCode === 5
    && err.cause?.code === 'EISDIR');
});

test('attach mode: loopback http accepted, non-loopback http and credentials in URL refused, wrong password → AUTH_FAILED', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-'));
  const password = 'attach-password-0123456789';
  const fake = await startFake({ port: 0, password, stateFile: path.join(dir, 'fake.json') });
  t.after(() => fake.close());
  const { env, ctx, stateDir } = makeServerCtx(t);
  const attached = await ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: password } });
  assert.deepEqual({ attached: attached.attached, pid: attached.pid, url: attached.url }, { attached: true, pid: null, url: fake.url });
  assert.ok(attached.warnings.some((w) => /Modo attach/.test(w)));
  assert.equal(fs.existsSync(path.join(stateDir, 'server.json')), false);
  assert.equal(readFakeState(env).bootAttempts, 0);
  for (const url of ['http://example.com:4096', 'ftp://127.0.0.1:1', 'https://user:pw@example.com', 'not a url']) {
    await assert.rejects(ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: url } }), (e) => e.code === 'INSECURE_SERVER_URL' && e.exitCode === 2, url);
  }
  await assert.rejects(ensureServer({ ...ctx, env: { ...env, OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: 'wrong-password-000000' } }), (e) => e.code === 'AUTH_FAILED');
});
