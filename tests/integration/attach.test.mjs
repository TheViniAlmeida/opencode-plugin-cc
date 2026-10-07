import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FAKE_BIN_DIR, makeTempDir, trackTempDir, makeWorkspace, testEnv, runCli, writeGlobalConfig, stateDirFor, startExternalFake, REPO_ROOT } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { PANE_SCRIPT } from '../../plugins/opc/scripts/commands/attach.mjs';
import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import { resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

const ATTACH_PROBE = join(REPO_ROOT, 'tests/fixtures/attach-probe.mjs');

test('attach reports the configured OpenCode binary', async (t) => {
  const configured = join(FAKE_BIN_DIR, 'opencode');
  const { cwd, env } = await setup(t, { extra: { OPC_OPENCODE_BIN: configured } });
  const result = await runCli(['attach', SEED.session, '--json'], { env, cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).argv[0], configured);
});

function scratch(t) {
  return trackTempDir(t, makeTempDir('opc-attach-'));
}

async function setup(t, { name = 'ws', extra = {} } = {}) {
  const cwd = makeWorkspace(t, { name });
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { TMUX: '', ...extra } });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const serverRecord = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8'));

test('server spawn writes attach.secret (0600, same password) and stop removes it', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['sessions'], { env, cwd })).code, 0);
  const stateDir = await stateDirFor(env, cwd);
  const secretPath = join(stateDir, 'attach.secret');
  assert.equal(readFileSync(secretPath, 'utf8'), serverRecord(stateDir).password);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  assert.equal((await runCli(['setup', '--stop-server'], { env, cwd })).code, 0);
  assert.equal(existsSync(secretPath), false);
});

test('attach prints the command without the password; workspace with spaces is quoted', async (t) => {
  const { cwd, env } = await setup(t, { name: 'meu ws ç' });
  const res = await runCli(['attach', SEED.session], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const stateDir = await stateDirFor(env, cwd);
  const { password, url } = serverRecord(stateDir);
  const root = resolveWorkspaceRoot(cwd);
  assert.ok(!res.stdout.includes(password) && !res.stderr.includes(password));
  assert.ok(res.stdout.includes(`OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(join(stateDir, 'attach.secret'))})"`));
  assert.ok(res.stdout.includes(`cd ${shellQuote(root)} && OPENCODE_SERVER_PASSWORD=`));
  assert.ok(res.stdout.includes(`opencode --server ${url} -s ${SEED.session}`));
  const json = JSON.parse((await runCli(['attach', SEED.session, '--json'], { env, cwd })).stdout);
  assert.deepEqual(json.argv, ['opencode', '--server', url, '-s', SEED.session]);
  assert.deepEqual(json.authSource, { type: 'file', path: join(stateDir, 'attach.secret') });
  assert.equal(json.attached, false);
  assert.ok(!JSON.stringify(json).includes(password));
});

test('attach without id uses the session of the last job; unknown session → exit 2', async (t) => {
  const { cwd, env } = await setup(t, { extra: { OPC_COMPANION_SESSION_ID: 'claude-attach' } });
  assert.equal((await runCli(['sessions'], { env, cwd })).code, 0);
  const stateDir = await stateDirFor(env, cwd);
  await createJob(stateDir, { kind: 'task', title: 'done', status: 'completed', claudeSessionId: 'claude-attach', sessionID: SEED.session, workspaceRoot: cwd });
  const json = JSON.parse((await runCli(['attach', '--json'], { env, cwd })).stdout);
  assert.equal(json.sessionID, SEED.session);
  assert.equal((await runCli(['attach', 'ses_missing'], { env, cwd })).code, 2);
  assert.equal((await runCli(['attach', 'not-a-session'], { env, cwd })).code, 2);
});

test('attach rejects extra positionals before connecting', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['attach', SEED.session, 'unexpected-value-long'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /Argumento inesperado: unexpected-v…/);
  assert.ok(!res.stdout.includes('unexpected-value-long'));
});

test('--pane outside tmux is refused and tmux is never called', async (t) => {
  const log = join(scratch(t), 'tmux.log');
  const { cwd, env } = await setup(t, { extra: { FAKE_TMUX_LOG: log } });
  const res = await runCli(['attach', SEED.session, '--pane'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /tmux/);
  assert.equal(existsSync(log), false);
});

test('pane: tmux argv has no password and the pane script receives intact args', async (t) => {
  const dir = scratch(t);
  const log = join(dir, 'tmux.log');
  const probeLog = join(dir, 'probe.log');
  const { cwd, env } = await setup(t, { name: 'pane ws ç', extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_LOG: log, OPC_OPENCODE_BIN: ATTACH_PROBE } });
  const res = await runCli(['attach', SEED.session, '--pane', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).pane.id, '%42');
  const stateDir = await stateDirFor(env, cwd);
  const { password, url } = serverRecord(stateDir);
  const root = resolveWorkspaceRoot(cwd);
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  const { argv, hasPasswordEnv } = entries[0];
  assert.equal(hasPasswordEnv, false);
  assert.ok(argv.every((a) => !a.includes(password)), 'password must never be in tmux argv');
  assert.deepEqual(argv.slice(0, 7), ['split-window', '-h', '-P', '-F', '#{pane_id}', '-c', root]);
  const script = join(stateDir, 'attach-pane.sh');
  assert.equal(statSync(script).mode & 0o777, 0o700);
  assert.equal(readFileSync(script, 'utf8'), PANE_SCRIPT);
  assert.ok(!readFileSync(script, 'utf8').includes(password));
  const sha = createHash('sha256').update(password).digest('hex');
  const ran = spawnSync('/bin/sh', ['-c', argv[7]], { env: { PATH: process.env.PATH, PROBE_LOG: probeLog, EXPECTED_SHA256: sha }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const probe = JSON.parse(readFileSync(probeLog, 'utf8').trim());
  assert.deepEqual(probe.argv, ['--server', url, '-s', SEED.session]);
  assert.equal(probe.cwd, root);
  assert.equal(probe.passwordMatches, true);
  assert.equal(probe.passwordInArgv, false);
});

test('pane: tmux failure is reported with exit 2', async (t) => {
  const { cwd, env } = await setup(t, { extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_FAIL: '1', OPC_OPENCODE_BIN: ATTACH_PROBE } });
  const res = await runCli(['attach', SEED.session, '--pane'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /tmux split-window falhou/);
});

test('attach mode (OPC_SERVER_URL) uses an external V2 server without managing it', async (t) => {
  const ext = await startExternalFake(t, { scenario: 'f3-sessions' });
  const log = join(scratch(t), 'tmux.log');
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { OPC_SERVER_URL: ext.url, OPC_SERVER_PASSWORD: ext.password, TMUX: '/tmp/fake-tmux,1,0', FAKE_TMUX_LOG: log } });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const sid = SEED.session;
  assert.ok(ext.fake.state.sessions[sid], 'seeded session must exist on the external server');

  const att = await runCli(['attach', sid, '--json'], { env, cwd });
  assert.equal(att.code, 0, att.stderr);
  const info = JSON.parse(att.stdout);
  assert.equal(info.url, ext.url);
  assert.equal(info.attached, true);
  assert.deepEqual(info.authSource, { type: 'env', name: 'OPC_SERVER_PASSWORD' });
  const text = await runCli(['attach', sid], { env, cwd });
  assert.ok(!text.stdout.includes(ext.password));
  assert.match(text.stdout, /OPENCODE_SERVER_PASSWORD="\$OPC_SERVER_PASSWORD"/);

  const pane = await runCli(['attach', sid, '--pane'], { env, cwd });
  assert.equal(pane.code, 2);
  assert.equal(existsSync(log), false);
  const health = await fetch(`${ext.url}/api/info`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${ext.password}`).toString('base64')}` },
  });
  assert.equal(health.status, 200, 'external server must remain available after attach --pane');
  assert.equal((await health.json()).version, '2.0.22');

  const stateDir = await stateDirFor(env, cwd);
  assert.equal(existsSync(join(stateDir, 'server.json')), false);
  assert.equal(existsSync(join(stateDir, 'attach.secret')), false);
});
