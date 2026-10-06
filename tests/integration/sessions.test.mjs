import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, stateDirFor } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { serverLockPath } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { acquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';

async function setup(t, { scenario = 'f3-sessions', config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, config);
  return { cwd, env };
}

test('sessions: default lists only root OPC sessions of the workspace', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['sessions', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.sessions.map((s) => s.id), [SEED.session]);
  assert.equal(out.filtered, true);
  const text = await runCli(['sessions'], { env, cwd });
  assert.match(text.stdout, /# Sessões OPC/);
  assert.ok(text.stdout.includes(SEED.session));
  assert.ok(!text.stdout.includes(SEED.userSession));
});

test('sessions --all shows every session; --limit trims', async (t) => {
  const { cwd, env } = await setup(t);
  const all = JSON.parse((await runCli(['sessions', '--all', '--json'], { env, cwd })).stdout);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), [SEED.session, SEED.userSession].sort());
  const one = JSON.parse((await runCli(['sessions', '--all', '--limit', '1', '--json'], { env, cwd })).stdout);
  assert.equal(one.sessions.length, 1);
  assert.equal(one.total, 2);
});

// OpenCode 2 has no instance/dispose: --refresh only rereads the session list.
const refreshRequests = (env) => fakeRequests(env).filter((r) => /dispose/.test(r.path));
const listRequests = (env) => fakeRequests(env).filter((r) => r.method === 'GET' && r.path === '/api/session');

test('sessions --refresh only rereads the list (no instance dispose in OpenCode 2)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['sessions', '--refresh', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).sessions.map((s) => s.id), [SEED.session]);
  assert.equal(refreshRequests(env).length, 0);
  assert.equal(fakeRequests(env).filter((r) => r.method !== 'GET').length, 0);
  // One listing: the first page and its cursor page that comes back empty.
  assert.deepEqual(listRequests(env).map((r) => typeof r.query.cursor), ['undefined', 'string']);
});

test('sessions --refresh is not refused while a job is active', async (t) => {
  const { cwd, env } = await setup(t);
  const stateDir = await stateDirFor(env, cwd);
  ensurePrivateDir(stateDir);
  await createJob(stateDir, { kind: 'task', title: 'active', status: 'running', workspaceRoot: cwd });
  const res = await runCli(['sessions', '--refresh', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).sessions.map((s) => s.id), [SEED.session]);
  assert.equal(refreshRequests(env).length, 0);
});

test('sessions --refresh waits for server.lock and is not refused by a job registered meanwhile', async (t) => {
  const { cwd, env } = await setup(t);
  const boot = await runCli(['sessions', '--json'], { env, cwd });
  assert.equal(boot.code, 0, boot.stderr);
  const stateDir = await stateDirFor(env, cwd);
  const release = await acquireLock(serverLockPath(stateDir), { timeoutMs: 1000, purpose: 'test-refresh-race' });
  try {
    const pending = runCli(['sessions', '--refresh', '--json'], { env, cwd });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await createJob(stateDir, { kind: 'task', title: 'registered while refresh waits', status: 'running', workspaceRoot: cwd });
    release();
    const res = await pending;
    assert.equal(res.code, 0, res.stderr);
    assert.equal(refreshRequests(env).length, 0);
  } finally {
    release();
  }
});
