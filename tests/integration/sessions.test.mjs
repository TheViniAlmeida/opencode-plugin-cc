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
  assert.match(text.stdout, /ses_seed/);
  assert.doesNotMatch(text.stdout, /ses_user/);
});

test('sessions --all shows every session; --limit trims', async (t) => {
  const { cwd, env } = await setup(t);
  const all = JSON.parse((await runCli(['sessions', '--all', '--json'], { env, cwd })).stdout);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), [SEED.session, SEED.userSession].sort());
  const one = JSON.parse((await runCli(['sessions', '--all', '--limit', '1', '--json'], { env, cwd })).stdout);
  assert.equal(one.sessions.length, 1);
  assert.equal(one.total, 2);
});

test('sessions --refresh disposes the instance', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['sessions', '--refresh', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/instance/dispose').length, 1);
});

test('sessions --refresh is refused while a job is active', async (t) => {
  const { cwd, env } = await setup(t);
  const stateDir = await stateDirFor(env, cwd);
  ensurePrivateDir(stateDir);
  const job = await createJob(stateDir, { kind: 'task', title: 'active', status: 'running', workspaceRoot: cwd });
  const res = await runCli(['sessions', '--refresh'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, new RegExp(job.id));
  assert.equal(fakeRequests(env).filter((r) => r.path === '/instance/dispose').length, 0);
});

test('sessions --refresh sees a job registered while it waits for server.lock', async (t) => {
  const { cwd, env } = await setup(t);
  const boot = await runCli(['sessions', '--json'], { env, cwd });
  assert.equal(boot.code, 0, boot.stderr);
  const stateDir = await stateDirFor(env, cwd);
  const release = await acquireLock(serverLockPath(stateDir), { timeoutMs: 1000, purpose: 'test-refresh-race' });
  try {
    const pending = runCli(['sessions', '--refresh'], { env, cwd });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const job = await createJob(stateDir, { kind: 'task', title: 'registered while refresh waits', status: 'running', workspaceRoot: cwd });
    release();
    const res = await pending;
    assert.equal(res.code, 2);
    assert.match(res.stdout + res.stderr, new RegExp(job.id));
    assert.equal(fakeRequests(env).filter((r) => r.path === '/instance/dispose').length, 0);
  } finally {
    release();
  }
});
