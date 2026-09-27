import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { startFake } from '../fixtures/fake-opencode.mjs';
import { terminalAlias } from '../../plugins/opc/scripts/commands/setup.mjs';
import {
  FAKE_BIN_DIR, makeTempDir, makeWorkspace, parseJsonOutput, readFakeState, readJsonFile, registerStopper, runCli, testEnv, trackTempDir,
} from '../helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'POSIX modes' };

test('terminal alias treats shell metacharacters in dataDir literally', async (t) => {
  const temp = trackTempDir(t, makeTempDir('opc-alias-'));
  const dataDir = path.join(temp, "$HOME `touch pwned` $(echo x) space's");
  const aliasLine = terminalAlias(dataDir, path.join(temp, 'plugin root'));
  assert.doesNotMatch(aliasLine, /OPC_DATA_DIR="/);
  assert.match(aliasLine, /\\'\\''/);
  const res = spawnSync('bash', ['-c', `${aliasLine}; alias opc`], { cwd: temp, env: process.env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.error?.message);
  assert.match(res.stdout, /\$HOME/);
  assert.match(res.stdout, /`touch pwned`/);
  assert.match(res.stdout, /\$\(echo x\)/);
  assert.match(res.stdout, /space.*\\'\\''.*s/);
  const companion = path.join(temp, 'plugin root', 'scripts', 'opc-companion.mjs');
  assert.ok(aliasLine.includes(`'\\''${companion}'\\''`), 'companion path must be shell quoted');
  assert.equal(fs.existsSync(path.join(temp, 'pwned')), false);
});

async function setupJson(env, ws, extra = []) {
  const res = await runCli(['setup', '--json', ...extra], { env, cwd: ws });
  return { ...res, report: parseJsonOutput(res.stdout) };
}

test('diagnostic JSON: node, opencode, dirs, config and a running server on a port chosen by the plugin', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.ready, true);
  assert.equal(report.node.ok, true);
  assert.deepEqual({ installed: report.opencode.installed, version: report.opencode.version, supported: report.opencode.supported }, { installed: true, version: '1.18.32', supported: true });
  assert.equal(report.dataDir, env.OPC_DATA_DIR);
  assert.equal(report.workspaceRoot, ws);
  assert.equal(report.server.status, 'running');
  assert.equal(report.server.reused, false);
  assert.notEqual(report.server.port, 4096);
  assert.equal(report.server.url, `http://127.0.0.1:${report.server.port}`);
  assert.equal(report.server.sessionsBlocked, null);
  assert.match(report.terminalAlias, /^alias opc=/);
  const fake = readFakeState(env);
  assert.equal(fake.boots[0].insideServer, '1');
  assert.equal(fake.boots[0].hasPassword, true);
  assert.equal(fake.boots[0].username, 'opencode');
  assert.equal(fake.boots[0].configContent, JSON.stringify({ share: 'disabled' }));
  assert.equal(fake.boots[0].hostname, '127.0.0.1');
  assert.ok(fake.requests.some((r) => r.path === '/agent' && r.query.directory === ws), 'warm-up GET /agent?directory');
  assert.ok(fake.requests.some((r) => r.path === '/config'), 'world check GET /config');
});

test('markdown output (no --json) contains the alias and no password', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const res = await runCli(['setup'], { env, cwd: ws });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^# opc setup/);
  assert.match(res.stdout, /alias opc=/);
  const { password } = readJsonFile(path.join(parseJsonOutput((await runCli(['setup', '--json'], { env, cwd: ws })).stdout).stateDir, 'server.json'));
  assert.ok(!res.stdout.includes(password));
});

test('opencode missing from PATH → ready:false, installed:false, exit 5, nothing spawned', async (t) => {
  const env = testEnv(t);
  env.PATH = env.PATH.split(path.delimiter).filter((p) => p !== FAKE_BIN_DIR && !fs.existsSync(path.join(p, 'opencode'))).join(path.delimiter);
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.ready, false);
  assert.equal(report.opencode.installed, false);
  assert.equal(report.server.status, 'skipped');
  assert.ok(report.nextSteps.some((s) => /npm install -g opencode-ai/.test(s)));
});

test('version below the minimum → UNSUPPORTED_VERSION, exit 5, no server', async (t) => {
  const env = testEnv(t, { scenario: 'old-version' });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.opencode.supported, false);
  assert.equal(report.server.error.code, 'UNSUPPORTED_VERSION');
  assert.equal(readFakeState(env).bootAttempts, 0);
});

test('auth-401 → AUTH_FAILED, exit 5, one single boot, no orphan server', async (t) => {
  const env = testEnv(t, { scenario: 'auth-401' });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 5);
  assert.equal(report.server.error.code, 'AUTH_FAILED');
  const fake = readFakeState(env);
  assert.equal(fake.bootAttempts, 1);
  assert.ok(fake.signals.some((s) => s.signal === 'SIGTERM'), 'spawned server was terminated');
  assert.equal(fs.existsSync(path.join(report.stateDir, 'server.json')), false);
});

test('share-auto → sessions blocked (exit 4), record keeps world.shareBlocked', async (t) => {
  const env = testEnv(t, { scenario: 'share-auto' });
  const ws = makeWorkspace(t);
  const blocked = await setupJson(env, ws);
  assert.equal(blocked.code, 4);
  assert.equal(blocked.report.ready, false);
  assert.equal(blocked.report.server.status, 'running');
  assert.equal(blocked.report.server.sessionsBlocked, 'share-auto');
  assert.ok(blocked.report.server.warnings.some((w) => /share "auto"/.test(w)));
  assert.ok(blocked.report.nextSteps.some((s) => /configOverride\.share/.test(s)));
  assert.equal(readJsonFile(path.join(blocked.report.stateDir, 'server.json')).world.shareBlocked, true);
  const again = await setupJson(env, ws);
  assert.equal(again.report.server.reused, true);
  assert.equal(again.code, 4, 'the block persists on reuse');
});

test('world check warns when the OpenCode model/small_model is denied by the policy', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), JSON.stringify({ policy: { providers: { deny: ['fake-provider'] } } }));
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.ok(report.server.warnings.some((w) => /"model"/.test(w)));
  assert.ok(report.server.warnings.some((w) => /"small_model"/.test(w)));
});

test('.opc.json that widens allow or sets locked keys is ignored with warnings', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), JSON.stringify({ policy: { models: { allow: ['prov-a/*'] } } }));
  fs.writeFileSync(path.join(ws, '.opc.json'), JSON.stringify({
    policy: { models: { allow: ['prov-b/*'] }, approver: 'claude' },
    permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
    server: { configOverride: { share: 'auto' } },
  }));
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.config.workspaceFound, true);
  const warned = report.config.warnings.map((w) => w.path);
  for (const p of ['policy.models.allow', 'policy.approver', 'permissionProfiles', 'server.configOverride']) assert.ok(warned.includes(p), `${p} in ${warned}`);
  assert.equal(readFakeState(env).boots[0].configContent, JSON.stringify({ share: 'disabled' }));
});

test('data dir: the same state is seen through CLAUDE_PLUGIN_DATA and OPC_DATA_DIR', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  const viaPlugin = { ...env, CLAUDE_PLUGIN_DATA: env.OPC_DATA_DIR };
  delete viaPlugin.OPC_DATA_DIR;
  const second = await setupJson(viaPlugin, ws);
  assert.equal(second.report.dataDir, first.report.dataDir);
  assert.equal(second.report.stateDir, first.report.stateDir);
  assert.equal(second.report.server.reused, true);
  assert.equal(second.report.server.pid, first.report.server.pid);
});

test('setup bootstraps ~/.claude/plugins/data/opc-opencode-plugin-cc when nothing else resolves', async (t) => {
  const env = testEnv(t);
  delete env.OPC_DATA_DIR;
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0);
  assert.equal(report.dataDir, path.join(env.HOME, '.claude', 'plugins', 'data', 'opc-opencode-plugin-cc'));
  await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
});

test('permissions: dirs 700, server.json and server.log 600', posixOnly, async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { report } = await setupJson(env, ws);
  for (const dir of [report.dataDir, path.join(report.dataDir, 'state'), report.stateDir]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  for (const file of ['server.json', 'server.log']) {
    assert.equal(fs.statSync(path.join(report.stateDir, file)).mode & 0o777, 0o600, file);
  }
});

test('OPC_SERVER_URL non-loopback over http is refused (exit 2, INSECURE_SERVER_URL)', async (t) => {
  const env = testEnv(t, { extra: { OPC_SERVER_URL: 'http://example.com:4096' } });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 2);
  assert.equal(report.server.error.code, 'INSECURE_SERVER_URL');
  assert.equal(readFakeState(env).bootAttempts, 0);
  const withCreds = testEnv(t, { extra: { OPC_SERVER_URL: 'https://user:pw@example.com' } });
  assert.equal((await setupJson(withCreds, ws)).report.server.error.code, 'INSECURE_SERVER_URL');
});

test('attach mode on loopback: validates health with OPC_SERVER_PASSWORD, never spawns nor stops', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-'));
  const password = 'attach-password-0123456789';
  const fake = await startFake({ port: 0, password, stateFile: path.join(dir, 'fake.json') });
  registerStopper(t, () => fake.close());
  const env = testEnv(t, { extra: { OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: password } });
  const ws = makeWorkspace(t);
  const { code, report } = await setupJson(env, ws);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.server.status, 'attached');
  assert.equal(report.server.attached, true);
  assert.ok(report.server.warnings.some((w) => /Modo attach/.test(w)));
  assert.equal(readFakeState(env).bootAttempts, 0);
  assert.equal(fs.existsSync(path.join(report.stateDir, 'server.json')), false);
  const stop = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(parseJsonOutput(stop.stdout).stop.reason, 'attached');
  const health = await fetch(`${fake.url}/global/health`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  assert.equal(health.status, 200);
  const wrong = testEnv(t, { extra: { OPC_SERVER_URL: fake.url, OPC_SERVER_PASSWORD: 'wrong-password-000000' } });
  const denied = await setupJson(wrong, ws);
  assert.equal(denied.code, 5);
  assert.equal(denied.report.server.error.code, 'AUTH_FAILED');
});
