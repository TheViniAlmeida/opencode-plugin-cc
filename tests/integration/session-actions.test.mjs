import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState } from '../helpers.mjs';
import { F3_TEST_CONFIG, SEED } from '../fixtures/f3-fake.mjs';
import { EMPTY_DIFF_NOTICE } from '../../plugins/opc/scripts/commands/session.mjs';

async function setup(t, { scenario = 'f3-sessions', extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  return { cwd, env };
}

const posts = (env, path) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === path);
const IDLE_ID = 'msg_00000000000500000000000005';
const sessionCreates = (env) => posts(env, '/api/session');

test('session new: title prefix, agent, model {id, providerID} and read-only rules', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--title', 'meu teste', '--agent', 'build', '--model', 'strong', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const { session } = JSON.parse(res.stdout);
  assert.equal(session.title, 'OPC: session: meu teste');
  const body = sessionCreates(env).at(-1).body;
  assert.equal(body.title, 'OPC: session: meu teste');
  assert.equal(body.agent, 'build');
  assert.deepEqual(body.model, { id: 'opencode-go/qwen3.8-max', providerID: 'omniroute-personal' });
  assert.deepEqual(body.permissions[0], { action: '*', resource: '*', effect: 'deny' });
});

test('session new --write sends write rules (no deny-all first rule)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'new', '--write', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const body = sessionCreates(env).at(-1).body;
  assert.equal(body.title, 'OPC: session: manual');
  assert.notDeepEqual(body.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.ok(body.permissions.some((r) => r.action === 'external_directory' && r.effect === 'deny'));
  assert.equal(body.permission, undefined, 'V1 permission list is never sent');
});

test('session new refuses a denied agent (exit 4) and an unknown one (exit 2) before creating', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['session', 'new', '--agent', 'work-secret'], { env, cwd })).code, 4);
  assert.equal((await runCli(['session', 'new', '--agent', 'nope'], { env, cwd })).code, 2);
  assert.equal((await runCli(['session', 'new', '--model', 'omniroute-work/cx/gpt-5.5'], { env, cwd })).code, 4);
  assert.equal(sessionCreates(env).length, 0);
});

test('session new validates the configured default model before POST', async (t) => {
  const { cwd, env } = await setup(t);
  writeGlobalConfig(env, { ...F3_TEST_CONFIG, defaultModel: 'omniroute-work/cx/gpt-5.5' });
  const res = await runCli(['session', 'new', '--json'], { env, cwd });
  assert.equal(res.code, 4, res.stderr);
  assert.equal(sessionCreates(env).length, 0);
});

test('session show: session, status and flat messages with ids', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'show', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.session.id, SEED.session);
  assert.equal(out.status, 'idle');
  assert.deepEqual(out.messages.map((m) => m.id), [SEED.m1, SEED.m2, SEED.m3, SEED.m4, IDLE_ID]);
  assert.deepEqual(out.messages.map((m) => m.type), ['user', 'assistant', 'user', 'assistant', 'idle']);
  const list = fakeRequests(env).find((r) => r.method === 'GET' && r.path === `/api/session/${SEED.session}/message`);
  assert.equal(list.query.order, 'asc');
  const text = await runCli(['session', 'show', SEED.session], { env, cwd });
  assert.match(text.stdout, new RegExp(`# Sessão ${SEED.session}`));
  assert.ok(text.stdout.includes(SEED.m3));
  assert.match(text.stdout, /second answer/);
  assert.equal((await runCli(['session', 'show', 'ses_missing'], { env, cwd })).code, 2);
});

test('session show has no OpenCode 1 list-bug workaround: messages are always listed', async (t) => {
  const { cwd, env } = await setup(t);
  const json = await runCli(['session', 'show', SEED.session, '--json'], { env, cwd });
  assert.equal(json.code, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.equal(out.messages.length, 5);
  assert.equal(out.messagesUnavailable, undefined);
  assert.equal(out.reason, undefined);
  const text = await runCli(['session', 'show', SEED.session], { env, cwd });
  assert.doesNotMatch(text.stdout, /defeito do OpenCode/);
});

test('sessions, new, show, fork, children and diff mask runtime pattern tokens in text and JSON', async (t) => {
  const token = `ghp_${'Ab12'.repeat(10)}`;
  const { cwd, env } = await setup(t, { extra: { FAKE_SESSION_CONTENT: token } });
  for (const args of [
    ['sessions'], ['sessions', '--json'],
    ['session', 'new', '--title', token], ['session', 'new', '--title', token, '--json'],
    ['session', 'fork', SEED.session], ['session', 'fork', SEED.session, '--before', SEED.m3, '--json'],
    ['session', 'show', SEED.session, '--json'], ['session', 'show', SEED.session],
    ['session', 'diff', SEED.session, '--json'], ['session', 'diff', SEED.session],
  ]) {
    const res = await runCli(args, { env, cwd });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stdout.includes(token), args.join(' '));
    assert.match(res.stdout, /\*\*\*/);
  }
});

test('session diff rejects an explicitly empty message id before connecting', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'diff', SEED.session, '--message', ''], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /id inválido/);
  assert.equal(fakeRequests(env).length, 0);
});

test('session fork: body with and without before; forked history stops before the message', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'fork', SEED.session, '--before', SEED.m3, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.forkedFrom, { sessionID: SEED.session, messageID: SEED.m3 });
  assert.deepEqual(out.session.fork, { sessionID: SEED.session, boundary: SEED.m3 });
  assert.deepEqual(posts(env, `/api/session/${SEED.session}/fork`)[0].body, { before: SEED.m3 });
  const shown = JSON.parse((await runCli(['session', 'show', out.session.id, '--json'], { env, cwd })).stdout);
  assert.deepEqual(shown.messages.map((m) => m.id), [SEED.m1, SEED.m2]);
  const whole = await runCli(['session', 'fork', SEED.session, '--json'], { env, cwd });
  assert.equal(whole.code, 0, whole.stderr);
  assert.deepEqual(JSON.parse(whole.stdout).forkedFrom, { sessionID: SEED.session, messageID: null });
  assert.deepEqual(posts(env, `/api/session/${SEED.session}/fork`)[1].body, {});
  const text = await runCli(['session', 'fork', SEED.session, '--before', SEED.m3], { env, cwd });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`com o histórico anterior a ${SEED.m3}`));
});

test('session fork takes the boundary only through --before (a positional message id is refused)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'fork', SEED.session, SEED.m3, '--json'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(JSON.parse(res.stdout).error.code, 'UNKNOWN_OPTION');
  assert.match(JSON.parse(res.stdout).error.message, /--before/);
  assert.equal(posts(env, `/api/session/${SEED.session}/fork`).length, 0);
  const unknown = await runCli(['session', 'fork', SEED.session, '--before', 'msg_not_here', '--json'], { env, cwd });
  assert.equal(JSON.parse(unknown.stdout).error.code, 'BAD_REQUEST', unknown.stdout);
  assert.equal(unknown.code, 7);
});

test('session children lists child sessions', async (t) => {
  const { cwd, env } = await setup(t, { scenario: 'children' });
  const res = await runCli(['session', 'children', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.children.length, 2);
  assert.ok(out.children.every((c) => c.parentID === SEED.session));
  const query = fakeRequests(env).filter((r) => r.method === 'GET' && r.path === '/api/session' && r.query.parentID);
  // First page, then the cursor page that comes back empty (V2 fills cursor.next until an empty page).
  assert.deepEqual(query.map((r) => [r.query.parentID, typeof r.query.cursor]), [[SEED.session, 'undefined'], [SEED.session, 'string']]);
  const text = await runCli(['session', 'children', SEED.session], { env, cwd });
  assert.match(text.stdout, new RegExp(`Filhas de ${SEED.session}`));
  assert.match(text.stdout, /child one/);
});

test('session diff: whole session and huge diffs truncated inline', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_HUGE_DIFF: '1' } });
  const whole = JSON.parse((await runCli(['session', 'diff', SEED.session, '--json'], { env, cwd })).stdout);
  assert.equal(whole.source, 'session');
  assert.deepEqual(whole.notices, []);
  assert.ok(whole.diffs.some((d) => d.file === 'notes.txt'));
  const diffReq = fakeRequests(env).filter((r) => r.path === `/api/session/${SEED.session}/diff`);
  assert.equal(diffReq.length, 1);
  assert.deepEqual(diffReq[0].query, {});
  const text = await runCli(['session', 'diff', SEED.session], { env, cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /fora do diff inline/);
  assert.ok(Buffer.byteLength(text.stdout) < 450 * 1024);
});

test('session diff --message is not available in OpenCode 2 and nothing is requested', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'diff', SEED.session, '--message', SEED.m3, '--json'], { env, cwd });
  assert.equal(res.code, 2);
  const { error } = JSON.parse(res.stdout);
  assert.equal(error.code, 'UNKNOWN_OPTION');
  assert.match(error.message, /OpenCode 2/);
  assert.equal(fakeRequests(env).filter((r) => r.path.endsWith('/diff')).length, 0);
});

test('session diff: an empty aggregate stays empty with a git notice (no per-message fallback in OpenCode 2)', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_EMPTY_SESSION_DIFF: '1' } });
  const out = JSON.parse((await runCli(['session', 'diff', SEED.session, '--json'], { env, cwd })).stdout);
  assert.equal(out.source, 'session');
  assert.deepEqual(out.diffs, []);
  // OpenCode 2.0.22 may answer [] even after edits: the notice points to the workspace git, nothing is derived.
  assert.deepEqual(out.notices, [EMPTY_DIFF_NOTICE]);
  assert.match(EMPTY_DIFF_NOTICE, /OpenCode não informou alterações/);
  assert.match(EMPTY_DIFF_NOTICE, /git diff/);
  const text = await runCli(['session', 'diff', SEED.session], { env, cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, new RegExp(`# Diff da sessão ${SEED.session}\\n\\nNenhuma alteração registrada`));
  assert.ok(text.stdout.includes(`Aviso: ${EMPTY_DIFF_NOTICE}`));
  const diffReq = fakeRequests(env).filter((r) => r.path.endsWith('/diff'));
  assert.equal(diffReq.length, 2, 'one aggregate read per invocation');
  assert.ok(diffReq.every((r) => r.query.messageID === undefined));
});

test('session todo was removed: unknown subcommand, nothing requested', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['session', 'todo', SEED.session, '--json'], { env, cwd });
  assert.equal(res.code, 2);
  const { error } = JSON.parse(res.stdout);
  assert.equal(error.code, 'UNKNOWN_SUBCOMMAND');
  assert.doesNotMatch(error.message, /new, show, fork, revert, unrevert, summarize, children, diff.*todo/);
  assert.equal(fakeRequests(env).length, 0);
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
    ['session', 'fork', SEED.session, '--before', 'msg$(id)'],
    ['session', 'revert', SEED.session, 'msg$(id)', '--confirmed-by-user'],
    ['session', 'show', 'msg_wrong_prefix'],
    ['session', 'diff', SEED.session, '--message', 'nope'],
  ]) {
    const res = await runCli(args, { env, cwd });
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stdout + res.stderr, /id inválido/, args.join(' '));
  }
  let started = true;
  try { readFakeState(env); } catch { started = false; }
  assert.ok(!started || fakeRequests(env).every((r) => !r.path.startsWith('/api/session')), 'no session request expected');
  assert.equal(existsSync(`${cwd}/pwned`), false);
});
