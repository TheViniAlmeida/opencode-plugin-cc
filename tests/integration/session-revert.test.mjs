import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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

test('revert without --confirmed-by-user: exit 2, affected diff and instruction, nothing reverted', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout, /confirmação necessária \(revert\)/);
  assert.match(res.stdout, /notes\.txt/);
  assert.match(res.stdout, /extra\.txt/);
  assert.match(res.stdout, /\+BETA/);
  assert.match(res.stdout, /opc session revert ses_seed msg_seed_003 --confirmed-by-user/);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
  const json = await runCli(['session', 'revert', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(json.code, 2);
  const out = JSON.parse(json.stdout);
  assert.equal(out.confirmed, false);
  assert.deepEqual(out.affected.map((d) => d.file).sort(), ['extra.txt', 'notes.txt']);
});

test('revert with --confirmed-by-user posts {messageID, partID?} and shows the revert marker', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/revert`)[0].body, { messageID: SEED.m3 });
  assert.equal(JSON.parse(res.stdout).session.revert.messageID, SEED.m3);
  const withPart = await runCli(['session', 'revert', SEED.session, SEED.m1, '--part', 'prt_seed_001', '--confirmed-by-user'], { env, cwd });
  assert.equal(withPart.code, 0, withPart.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/revert`)[1].body, { messageID: SEED.m1, partID: 'prt_seed_001' });
  assert.match(withPart.stdout, /Revert aplicado/);
});

test('revert JSON masks runtime-built pattern tokens in patch previews and returned sessions', async (t) => {
  const { cwd, env } = await setup(t);
  const token = `sk-proj-${'Z'.repeat(24)}`;
  env.FAKE_SESSION_CONTENT = token;
  const preview = await runCli(['session', 'revert', SEED.session, SEED.m1, '--json'], { env, cwd });
  assert.equal(preview.code, 2);
  assert.ok(!preview.stdout.includes(token));
  assert.match(preview.stdout, /\*\*\*/);
  const done = await runCli(['session', 'revert', SEED.session, SEED.m1, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.ok(!done.stdout.includes(token));
});

test('unknown message is refused before any revert', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_not_here', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /não pertence à sessão/);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
});

test('revert preview falls back to the target message after a formatted turn breaks message listing', async (t) => {
  const { cwd, env } = await setup(t);
  writeGlobalConfig(env, { ...F3_TEST_CONFIG, review: { structuredOutput: 'tool' } });
  writeFileSync(join(cwd, 'README.md'), '# formatted review target\n\nA change for the fake review.\n');
  env.FAKE_FORMAT_LIST_BUG = '1';
  env.FAKE_TARGET_DIFF = '1'; // the target message's own diff, served by GET /session/:id/diff?messageID=
  const session = await runCli(['review', '--wait', '--json'], {
    env,
    cwd,
  });
  assert.equal(session.code, 0, session.stderr);
  const state = readFakeState(env);
  const promptPath = fakeRequests(env).find((request) => request.method === 'POST' && /\/prompt_async$/.test(request.path)).path;
  const sessionID = promptPath.split('/')[2];
  const messageID = state.messages[sessionID].find((message) => message.info.role === 'user').info.id;

  const preview = await runCli(['session', 'revert', sessionID, '--message', messageID, '--json'], { env, cwd });
  assert.equal(preview.code, 2);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.confirmed, false);
  assert.equal(result.messageID, messageID);
  assert.ok(result.affected.some((entry) => (entry.file ?? entry.path) === 'target.txt'), `preview includes the target message diff: ${JSON.stringify(result.affected)}`);
  assert.match(result.notice, /não foi possível enumerar os turnos posteriores/i);

  const unknown = await runCli(['session', 'revert', sessionID, '--message', 'msg_unknown', '--json'], { env, cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout + unknown.stderr, /não pertence à sessão/);
});

test('revert rejects a message id with path characters', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'revert', SEED.session, 'msg_1/../x', '--confirmed-by-user'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
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
  assert.equal(posts(env, `/session/${SEED.session}/revert`).length, 0);
});

test('unrevert: nothing to undo → exit 2; preview shows revert diff; confirmed posts unrevert', async (t) => {
  const { cwd, env } = await setup(t);
  const none = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(none.code, 2);
  assert.match(none.stdout + none.stderr, /não tem revert ativo/);
  assert.equal((await runCli(['session', 'revert', SEED.session, SEED.m3, '--confirmed-by-user'], { env, cwd })).code, 0);
  const preview = await runCli(['session', 'unrevert', SEED.session], { env, cwd });
  assert.equal(preview.code, 2);
  assert.match(preview.stdout, /confirmação necessária \(unrevert\)/);
  assert.match(preview.stdout, /\+BETA/);
  assert.match(preview.stdout, /opc session unrevert ses_seed --confirmed-by-user/);
  assert.equal(posts(env, `/session/${SEED.session}/unrevert`).length, 0);
  const done = await runCli(['session', 'unrevert', SEED.session, '--confirmed-by-user', '--json'], { env, cwd });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(posts(env, `/session/${SEED.session}/unrevert`).length, 1);
  assert.equal(JSON.parse(done.stdout).session.revert, undefined);
});

test('summarize: model from --model (alias) or routing; denied model refused', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'summarize', SEED.session, '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(posts(env, `/session/${SEED.session}/summarize`)[0].body, { providerID: 'omniroute-personal', modelID: 'opencode-go/qwen3.8-max' });
  assert.equal(JSON.parse(res.stdout).model, 'omniroute-personal/opencode-go/qwen3.8-max');
  assert.equal((await runCli(['session', 'summarize', SEED.session], { env, cwd })).code, 0);
  assert.deepEqual(posts(env, `/session/${SEED.session}/summarize`)[1].body, { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal((await runCli(['session', 'summarize', SEED.session, '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(posts(env, `/session/${SEED.session}/summarize`).length, 2);
});
