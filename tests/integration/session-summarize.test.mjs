import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { PENDING_REVERT_NOTICE, waitCompaction } from '../../plugins/opc/scripts/commands/session.mjs';

async function setup(t, extra = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  return { cwd, env };
}

test('summarize waits for an asynchronous compaction before reporting it done', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_COMPACT_ASYNC_MS: '600' });
  const started = Date.now();
  const res = await runCli(['session', 'summarize', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(Date.now() - started >= 500, 'returned before the compaction ended');
  assert.equal(JSON.parse(res.stdout).summarized, true);
});

test('summarize times out without claiming the session was summarized', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_COMPACT_ASYNC_MS: '60000' });
  const res = await runCli(['session', 'summarize', SEED.session, '--timeout', '1', '--json'], { env, cwd });
  assert.equal(res.code, 5); // ConnectionError('TIMEOUT'), the exit code opc already gives timeouts
  assert.match(res.stdout + res.stderr, /compactação continua no servidor/);
  assert.doesNotMatch(res.stdout, /"summarized":true/);
});

test('summarize warns on stderr when the session has a pending revert', async (t) => {
  const { cwd, env } = await setup(t);
  const staged = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd });
  assert.equal(staged.code, 0, staged.stderr);
  const res = await runCli(['session', 'summarize', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stderr.includes(PENDING_REVERT_NOTICE), res.stderr);
  assert.equal(JSON.parse(res.stdout).summarized, true);
  const clean = await setup(t);
  const quiet = await runCli(['session', 'summarize', SEED.session, '--json'], { env: clean.env, cwd: clean.cwd });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.ok(!quiet.stderr.includes(PENDING_REVERT_NOTICE));
});

test('waitCompaction: true once idle and not compacting, false at the deadline', async () => {
  let compacting = true;
  const api = {
    sessionStatus: async () => ({}),
    getSession: async () => ({ time: compacting ? { compacting: 1 } : {} }),
  };
  setTimeout(() => { compacting = false; }, 60);
  assert.equal(await waitCompaction(api, 'ses_x', { timeoutMs: 2000, pollMs: 10 }), true);
  assert.equal(await waitCompaction({ ...api, sessionStatus: async () => ({ ses_x: { type: 'busy' } }) }, 'ses_x', { timeoutMs: 50, pollMs: 10 }), false);
});
