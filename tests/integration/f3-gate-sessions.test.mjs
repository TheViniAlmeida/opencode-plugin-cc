import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import { F3_SESSION_ROUTES, F3_DATA, F3_TEST_CONFIG, SEED, seedSession, createSessionRecord, userMessage } from '../fixtures/f3-fake.mjs';
import { run as session } from '../../plugins/opc/scripts/commands/session.mjs';
import { run as sessions } from '../../plugins/opc/scripts/commands/sessions.mjs';
import { REVERT_SCOPE_NOTICE } from '../../plugins/opc/scripts/commands/session.mjs';

// Integrate the real commands, HTTP client and fake server routes using fetch in memory.
// This exercises the wire payloads without opening a socket in the sandbox.
function fixture(t) {
  const stateDir = trackTempDir(t, makeTempDir('opc-gate-sessions-'));
  const fake = { state: {}, emit() {}, persist() {} };
  const base = installSessionApi(fake);
  seedSession(fake);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? 'GET';
    const query = Object.fromEntries(url.searchParams);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, path: url.pathname, query });
    let reply;
    if (url.pathname === '/api/info') reply = { status: 200, body: { version: '2.0.22', pid: 1, urls: {}, paths: {} } };
    else if (url.pathname === '/api/model/default') reply = { status: 200, body: { data: { id: 'opencode-go/deepseek-v4.1-flash', modelID: 'opencode-go/deepseek-v4.1-flash', providerID: 'omniroute-personal' } } };
    else if (F3_DATA[`${url.pathname.slice(5)}.json`]) reply = { status: 200, body: { data: F3_DATA[`${url.pathname.slice(5)}.json`] } };
    else {
      for (const [route, handler] of Object.entries(F3_SESSION_ROUTES)) {
        const [verb, path] = route.split(' ');
        if (verb !== method) continue;
        const match = new RegExp(`^${path.replace(':id', '([^/]+)')}$`).exec(url.pathname);
        if (match) { reply = await handler(fake, { params: { id: match[1] }, query, body }); break; }
      }
      reply ??= await base.handle(method, url.pathname, url.searchParams, body);
    }
    assert.ok(reply, `rota fake ausente: ${method} ${url.pathname}`);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  const ctx = { stateDir, workspaceRoot: process.cwd(), config: F3_TEST_CONFIG,
    env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' }, err() {} };
  const run = async (command, args) => {
    let output = '';
    const code = await command({ ...ctx, out: (value) => { output += value; }, json: (value) => { output += JSON.stringify(value); } }, args);
    return { code, output };
  };
  return { fake, requests, run };
}

test('C1: todas as ações de sessão mascaram conteúdo fake em texto e JSON', async (t) => {
  const { fake, run } = fixture(t);
  const token = ['ghp', 'Cd34'.repeat(10)].join('_');
  fake.state.sessions[SEED.session].title = `OPC: ${token}`;
  fake.state.messages[SEED.session][0].text = token;
  fake.state.f3.diffs[SEED.session][0].patch += `+${token}\n`;
  fake.state.f3.messageDiffs[SEED.session][SEED.m1][0].patch += `+${token}\n`;
  createSessionRecord(fake, { title: token, parentID: SEED.session });
  for (const suffix of [[], ['--json']]) {
    const cases = [
      [sessions, [], 0], [sessions, ['--all'], 0],
      [session, ['new', '--title', token], 0], [session, ['show', SEED.session], 0],
      [session, ['fork', SEED.session], 0], [session, ['children', SEED.session], 0],
      [session, ['diff', SEED.session], 0],
      [session, ['summarize', SEED.session], 0],
      [session, ['revert', SEED.session, SEED.m1], 2],
      [session, ['revert', SEED.session, SEED.m1, '--confirmed-by-user'], 0],
      [session, ['unrevert', SEED.session], 2],
      [session, ['unrevert', SEED.session, '--confirmed-by-user'], 0],
    ];
    for (const [command, args, expected] of cases) {
      const { code, output } = await run(command, [...args, ...suffix]);
      assert.equal(code, expected, args[0]);
      assert.equal(output.includes(token), false, 'conteúdo fake não pode vazar');
      if (args[0] === 'show' || args[0] === 'diff') assert.ok(output.includes('***'), `mascaramento ausente: ${args[0]}`);
      if (suffix.length) assert.doesNotThrow(() => JSON.parse(output));
    }
  }
});

test('I3: fake com 250 mensagens valida alvo tardio sem atribuir diff da sessão ao revert', async (t) => {
  const { fake, requests, run } = fixture(t);
  fake.state.messages[SEED.session] = Array.from({ length: 250 }, (_, i) => userMessage(SEED.session, `msg_long_${i + 1}`, 'teste'));
  fake.state.f3.messageDiffs[SEED.session].msg_long_230 = [{ file: 'notes.txt', patch: '+TARGET' }];
  for (const suffix of [[], ['--json']]) {
    const { code, output } = await run(session, ['revert', SEED.session, 'msg_long_230', ...suffix]);
    assert.equal(code, 2);
    assert.ok(output.includes(REVERT_SCOPE_NOTICE));
    assert.ok(!output.includes('+TARGET'));
    if (suffix.length) assert.equal(JSON.parse(output).affected, null);
  }
  // V2 caps limit at 200: the 250 messages are read through the cursor, never with a larger limit.
  const messageReads = requests.filter((r) => r.path.endsWith('/message'));
  assert.ok(messageReads.some((r) => typeof r.query.cursor === 'string' && !('order' in r.query)));
  assert.ok(messageReads.every((r) => Number(r.query.limit) <= 200));
  assert.equal(requests.some((r) => r.method === 'POST' && r.path.endsWith('/revert/stage')), false);
  assert.equal((await run(session, ['revert', SEED.session, 'msg_long_230', '--confirmed-by-user'])).code, 0);
  assert.equal(fake.state.sessions[SEED.session].revert.messageID, 'msg_long_230');
  await assert.rejects(run(session, ['revert', SEED.session, 'msg_missing']), { code: 'UNKNOWN_MESSAGE' });
});
