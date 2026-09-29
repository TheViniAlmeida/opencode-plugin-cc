import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, stateDirFor, startExternalFake, REPO_ROOT } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { PANE_SCRIPT } from '../../plugins/opc/scripts/commands/attach.mjs';
import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import { resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

const ATTACH_PROBE = join(REPO_ROOT, 'tests/fixtures/attach-probe.mjs');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-attach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  assert.ok(res.stdout.includes(`opencode attach ${url} -s ${SEED.session} --dir ${shellQuote(root)}`));
  const json = JSON.parse((await runCli(['attach', SEED.session, '--json'], { env, cwd })).stdout);
  assert.deepEqual(json.argv, ['opencode', 'attach', url, '-s', SEED.session, '--dir', root]);
  assert.deepEqual(json.credential, { type: 'file', path: join(stateDir, 'attach.secret') });
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
  const { cwd, env } = await setup(t, { name: 'pane ws ç', extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_LOG: log, OPC_ATTACH_OPENCODE_BIN: ATTACH_PROBE } });
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
  assert.deepEqual(probe.argv, ['attach', url, '-s', SEED.session, '--dir', root]);
  assert.equal(probe.passwordMatches, true);
  assert.equal(probe.passwordInArgv, false);
});

test('pane: tmux failure is reported with exit 2', async (t) => {
  const { cwd, env } = await setup(t, { extra: { TMUX: '/tmp/fake-tmux,999,0', FAKE_TMUX_FAIL: '1', OPC_ATTACH_OPENCODE_BIN: ATTACH_PROBE } });
  const res = await runCli(['attach', SEED.session, '--pane'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /tmux split-window falhou/);
});

test('attach mode (OPC_SERVER_URL) end to end: sessions, subagent and attach on an external server', async (t) => {
  const ext = await startExternalFake(t, { scenario: 'f3-sessions' });
  const log = join(scratch(t), 'tmux.log');
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { OPC_SERVER_URL: ext.url, OPC_SERVER_PASSWORD: ext.password, TMUX: '/tmp/fake-tmux,1,0', FAKE_TMUX_LOG: log } });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const created = await runCli(['session', 'new', '--title', 'ext', '--json'], { env, cwd });
  assert.equal(created.code, 0, created.stderr);
  const sid = JSON.parse(created.stdout).session.id;
  assert.ok(ext.fake.state.sessions[sid], 'session must exist on the external server');
  const listed = JSON.parse((await runCli(['sessions', '--json'], { env, cwd })).stdout);
  assert.ok(listed.sessions.some((s) => s.id === sid));

  const sub = await runCli(['subagent', '--agent', 'general', '--model', 'fast', '--json', 'hi'], { env, cwd });
  assert.equal(sub.code, 0, sub.stdout + sub.stderr);
  assert.equal(JSON.parse(sub.stdout).group.status, 'completed');

  const att = await runCli(['attach', sid, '--json'], { env, cwd });
  assert.equal(att.code, 0, att.stderr);
  const info = JSON.parse(att.stdout);
  assert.equal(info.url, ext.url);
  assert.equal(info.attached, true);
  assert.deepEqual(info.credential, { type: 'env', name: 'OPC_SERVER_PASSWORD' });
  const text = await runCli(['attach', sid], { env, cwd });
  assert.ok(!text.stdout.includes(ext.password));
  assert.match(text.stdout, /OPENCODE_SERVER_PASSWORD="\$OPC_SERVER_PASSWORD"/);

  const pane = await runCli(['attach', sid, '--pane'], { env, cwd });
  assert.equal(pane.code, 2);
  assert.equal(existsSync(log), false);
  const refresh = await runCli(['sessions', '--refresh'], { env, cwd });
  assert.equal(refresh.code, 2);
  assert.equal(ext.fake.state.f3.disposed, 0);

  const stateDir = await stateDirFor(env, cwd);
  assert.equal(existsSync(join(stateDir, 'server.json')), false);
  assert.equal(existsSync(join(stateDir, 'attach.secret')), false);
});
