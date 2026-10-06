import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState, stateDirFor } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';

async function setup(t) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions' });
  writeGlobalConfig(env, F3_TEST_CONFIG); // servers stopped by the F0 per-test cleanup (testEnv/makeWorkspace)
  return { cwd, env };
}

const posts = (env, path) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === path);

const sessionPosts = (env, sessionID, suffix) => posts(env, `/api/session/${sessionID}/${suffix}`);
const NOTICE = /O OpenCode 2 não fornece um diff restrito às mensagens a partir do alvo/;

test('revert without --confirmed-by-user: exit 2, scope notice and instruction, nothing reverted', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /confirmação necessária \(revert\)/);
  assert.match(res.stdout, NOTICE);
  assert.match(res.stdout, new RegExp(`opc session revert ${SEED.session} ${SEED.m3} --confirmed-by-user`));
  assert.equal(sessionPosts(env, SEED.session, 'revert/stage').length, 0);
  assert.equal(sessionPosts(env, SEED.session, 'revert/commit').length, 0);
  const json = await runCli(['session', 'revert', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(json.code, 2);
  const out = JSON.parse(json.stdout);
  assert.equal(out.confirmed, false);
  assert.equal(out.action, 'revert');
  assert.equal(out.messageID, SEED.m3);
  assert.equal(out.affected, null);
  assert.match(out.notice, NOTICE);
  assert.equal(out.command, `opc session revert ${SEED.session} ${SEED.m3} --confirmed-by-user`);
  assert.equal(fakeRequests(env).filter((r) => r.method !== 'GET').length, 0, 'the preview only reads');
});

test('revert with --confirmed-by-user stages then commits {messageID} and shows the revert marker', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const stage = sessionPosts(env, SEED.session, 'revert/stage');
  const commit = sessionPosts(env, SEED.session, 'revert/commit');
  assert.deepEqual(stage.map((r) => r.body), [{ messageID: SEED.m3 }]);
  assert.equal(commit.length, 1);
  assert.ok(stage[0].at <= commit[0].at, 'stage runs before commit');
  const out = JSON.parse(res.stdout);
  assert.equal(out.confirmed, true);
  assert.equal(out.session.revert.messageID, SEED.m3);
  assert.equal(out.session.revert.committed, true);
  const text = await runCli(['session', 'revert', SEED.session, SEED.m1, '--confirmed-by-user'], { env, cwd });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Reversão aplicada/);
  assert.match(text.stdout, new RegExp(`Revert ativo: a partir de ${SEED.m1}`));
  assert.deepEqual(sessionPosts(env, SEED.session, 'revert/stage').map((r) => r.body), [{ messageID: SEED.m3 }, { messageID: SEED.m1 }]);
});

test('revert refuses --part (OpenCode 2 reverts by message) before staging anything', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m1, '--part', 'prt_seed_001', '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(JSON.parse(res.stdout).error.code, 'UNKNOWN_OPTION');
  assert.equal(sessionPosts(env, SEED.session, 'revert/stage').length, 0);
});

test('revert and unrevert output masks runtime-built pattern tokens in revert diffs and returned sessions', async (t) => {
  const { cwd, env } = await setup(t);
  const token = `sk-proj-${'Z'.repeat(24)}`;
  env.FAKE_SESSION_CONTENT = token;
  const preview = await runCli(['session', 'revert', SEED.session, SEED.m1, '--json'], { env, cwd });
  assert.equal(preview.code, 2);
  assert.ok(!preview.stdout.includes(token));
  const done = await runCli(['session', 'revert', SEED.session, SEED.m1, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.ok(!done.stdout.includes(token));
  assert.match(done.stdout, /\*\*\*/);
  for (const args of [['session', 'unrevert', SEED.session, '--json'], ['session', 'unrevert', SEED.session]]) {
    const undo = await runCli(args, { env, cwd });
    assert.equal(undo.code, 2);
    assert.ok(!undo.stdout.includes(token), args.join(' '));
    assert.match(undo.stdout, /\*\*\*/);
    assert.match(undo.stdout, /ALPHA/);
  }
});

test('unknown message is refused before any revert', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_not_here', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /não pertence à sessão/);
  assert.equal(sessionPosts(env, SEED.session, 'revert/stage').length, 0);
});

test('revert preview resolves a message of a session created by a real turn; unknown ids are refused', async (t) => {
  const { cwd, env } = await setup(t);
  const task = await runCli(['task', '--raw-args-stdin'], { env, cwd, stdin: 'say hello\n' });
  assert.equal(task.code, 0, task.stderr);
  const state = readFakeState(env);
  const sessionID = fakeRequests(env).find((request) => request.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(request.path)).path.split('/')[3];
  const messageID = state.messages[sessionID].find((message) => message.type === 'user').id;

  const preview = await runCli(['session', 'revert', sessionID, '--message', messageID, '--json'], { env, cwd });
  assert.equal(preview.code, 2);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.confirmed, false);
  assert.equal(result.messageID, messageID);
  assert.match(result.notice, NOTICE);

  const unknown = await runCli(['session', 'revert', sessionID, '--message', 'msg_unknown', '--json'], { env, cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout + unknown.stderr, /não pertence à sessão/);
});

test('revert rejects a message id with path characters', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_1/../x', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(sessionPosts(env, SEED.session, 'revert/stage').length, 0);
});

test('refuses when the session lock is held (active job on the session)', async (t) => {
  const { cwd, env } = await setup(t);
  const stateDir = await stateDirFor(env, cwd);
  ensurePrivateDir(stateDir);
  const release = tryAcquireLock(join(stateDir, `session-${SEED.session}.lock`), { purpose: 'job test' });
  t.after(() => release());
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /em uso/);
  assert.equal(sessionPosts(env, SEED.session, 'revert/stage').length, 0);
});

test('unrevert: nothing to undo → exit 2; preview shows revert diff; confirmed clears the revert', async (t) => {
  const { cwd, env } = await setup(t);
  const clears = () => fakeRequests(env).filter((r) => r.method === 'DELETE' && r.path === `/api/session/${SEED.session}/revert`);
  const none = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(none.code, 2);
  assert.match(none.stdout + none.stderr, /não tem reversão ativa/);
  assert.equal(clears().length, 0);
  assert.equal((await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd })).code, 0);
  const preview = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(preview.code, 2);
  assert.match(preview.stdout, /confirmação necessária \(unrevert\)/);
  assert.match(preview.stdout, /\+BETA/);
  assert.match(preview.stdout, new RegExp(`opc session unrevert ${SEED.session} --confirmed-by-user`));
  assert.equal(clears().length, 0);
  const done = await runCli(['session', 'unrevert', SEED.session, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(clears().length, 1);
  assert.equal(JSON.parse(done.stdout).session.revert, undefined);
  assert.equal(JSON.parse((await runCli(['session', 'show', SEED.session, '--json'], { env, cwd })).stdout).session.revert, undefined);
});

test('summarize: sets the session model then compacts; model from --model (alias) or routing; denied model refused', async (t) => {
  const { cwd, env } = await setup(t);
  const modelPosts = () => sessionPosts(env, SEED.session, 'model');
  const compacts = () => sessionPosts(env, SEED.session, 'compact');
  const res = await runCli(['session', 'summarize', SEED.session, '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(modelPosts()[0].body, { model: { providerID: 'omniroute-personal', id: 'opencode-go/qwen3.8-max' } });
  assert.equal(compacts().length, 1);
  assert.ok(modelPosts()[0].at <= compacts()[0].at, 'the model switch precedes the compaction');
  assert.equal(JSON.parse(res.stdout).model, 'omniroute-personal/opencode-go/qwen3.8-max');
  assert.equal((await runCli(['session', 'summarize', SEED.session], { env, cwd })).code, 0);
  assert.deepEqual(modelPosts()[1].body, { model: { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' } });
  assert.equal((await runCli(['session', 'summarize', SEED.session, '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(modelPosts().length, 2);
  assert.equal(compacts().length, 2);
  const shown = JSON.parse((await runCli(['session', 'show', SEED.session, '--json'], { env, cwd })).stdout);
  assert.ok(shown.messages.some((message) => message.type === 'assistant' && message.agent === 'compaction'));
});

test('summarize: --timeout bounds the compact request (default is long; a short flag fails a slow compaction)', async (t) => {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'f3-sessions', extra: { FAKE_COMPACT_DELAY_MS: '2500' } });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const slow = await runCli(['session', 'summarize', SEED.session, '--timeout', '1'], { env, cwd });
  assert.notEqual(slow.code, 0, 'the short --timeout aborts the slow compact request');
  assert.match(slow.stderr + slow.stdout, /TIMEOUT|sem resposta em 1000 ms/);
  const patient = await runCli(['session', 'summarize', SEED.session, '--timeout', '30', '--json'], { env, cwd });
  assert.equal(patient.code, 0, patient.stderr);
  assert.equal(JSON.parse(patient.stdout).summarized, true);
});
