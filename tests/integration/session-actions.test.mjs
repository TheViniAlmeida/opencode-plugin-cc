import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';

async function setup(t, { scenario = 'f3-sessions', extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  return { cwd, env };
}

const posts = (env, path) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === path);

test('session new: title prefix, agent, model {id, providerID} and read-only rules', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--title', 'meu teste', '--agent', 'build', '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { session } = JSON.parse(res.stdout);
  assert.equal(session.title, 'OPC: session: meu teste');
  const body = posts(env, '/session').at(-1).body;
  assert.equal(body.title, 'OPC: session: meu teste');
  assert.equal(body.agent, 'build');
  assert.deepEqual(body.model, { id: 'opencode-go/qwen3.8-max', providerID: 'omniroute-personal' });
  assert.deepEqual(body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('session new --write sends write rules (no deny-all first rule)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--write', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const body = posts(env, '/session').at(-1).body;
  assert.equal(body.title, 'OPC: session: manual');
  assert.notDeepEqual(body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.ok(body.permission.some((r) => r.permission === 'external_directory' && r.action === 'deny'));
});

test('session new refuses a denied agent (exit 4) and an unknown one (exit 2) before creating', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['session', 'new', '--agent', 'work-secret'], { env, cwd })).code, 4);
  assert.equal((await runCli(['session', 'new', '--agent', 'nope'], { env, cwd })).code, 2);
  assert.equal((await runCli(['session', 'new', '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(posts(env, '/session').length, 0);
});

test('session show: session, status and messages with ids', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'show', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.session.id, SEED.session);
  assert.equal(out.status, 'idle');
  assert.deepEqual(out.messages.map((m) => m.info.id), [SEED.m1, SEED.m2, SEED.m3, SEED.m4]);
  const text = await runCli(['session', 'show', SEED.session], { env, cwd });
  assert.match(text.stdout, /# Sessão ses_seed/);
  assert.match(text.stdout, /msg_seed_003/);
  assert.equal((await runCli(['session', 'show', 'ses_missing'], { env, cwd })).code, 2);
});

test('session fork: body with and without messageID; forked history stops before the message', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'fork', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.forkedFrom, { sessionID: SEED.session, messageID: SEED.m3 });
  assert.deepEqual(posts(env, `/session/${SEED.session}/fork`)[0].body, { messageID: SEED.m3 });
  const shown = JSON.parse((await runCli(['session', 'show', out.session.id, '--json'], { env, cwd })).stdout);
  assert.equal(shown.messages.length, 2);
  assert.equal((await runCli(['session', 'fork', SEED.session], { env, cwd })).code, 0);
  assert.deepEqual(posts(env, `/session/${SEED.session}/fork`)[1].body, {});
});

test('session children lists child sessions', async (t) => {
  const { cwd, env } = await setup(t, { scenario: 'children' });
  const res = await runCli(['session', 'children', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.children.length, 2);
  assert.ok(out.children.every((c) => c.parentID === SEED.session));
  assert.match((await runCli(['session', 'children', SEED.session], { env, cwd })).stdout, /Filhas de ses_seed/);
});

test('session diff: whole session, per message, and huge diffs truncated inline', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_HUGE_DIFF: '1' } });
  const whole = JSON.parse((await runCli(['session', 'diff', SEED.session, '--json'], { env, cwd })).stdout);
  assert.ok(whole.diffs.some((d) => d.file === 'notes.txt'));
  const perMessage = JSON.parse((await runCli(['session', 'diff', SEED.session, '--message', SEED.m3, '--json'], { env, cwd })).stdout);
  assert.deepEqual(perMessage.diffs.map((d) => d.file), ['notes.txt', 'extra.txt']);
  const diffReq = fakeRequests(env).filter((r) => r.path === `/session/${SEED.session}/diff`);
  assert.equal(diffReq.at(-1).query.messageID, SEED.m3);
  const text = await runCli(['session', 'diff', SEED.session], { env, cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /fora do diff inline/);
  assert.ok(Buffer.byteLength(text.stdout) < 450 * 1024);
});

test('session todo lists todos', async (t) => {
  const { cwd, env } = await setup(t);
  const out = JSON.parse((await runCli(['session', 'todo', SEED.session, '--json'], { env, cwd })).stdout);
  assert.equal(out.todos.length, 2);
  assert.match((await runCli(['session', 'todo', SEED.session], { env, cwd })).stdout, /check beta/);
});

test('session: unknown action and missing id are usage errors', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['session', 'explode'], { env, cwd })).code, 2);
  assert.equal((await runCli(['session', 'show'], { env, cwd })).code, 2);
});

test('rejects malformed ids without contacting the server', async (t) => {
  const { cwd, env } = await setup(t);
  for (const args of [
    ['session', 'show', 'ses_x/../../global/dispose'],
    ['session', 'fork', SEED.session, 'msg$(id)'],
    ['session', 'todo', 'msg_wrong_prefix'],
    ['session', 'diff', SEED.session, '--message', 'nope'],
  ]) {
    const res = await runCli(args, { env, cwd });
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stdout + res.stderr, /id inválido/);
  }
  let started = true;
  try { readFakeState(env); } catch { started = false; }
  assert.ok(!started || fakeRequests(env).every((r) => !r.path.startsWith('/session')), 'no session request expected');
  assert.equal(existsSync(`${cwd}/pwned`), false);
});
