import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { loadScenario, startFake } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { SEED, userMessage, assistantMessage } from '../fixtures/f3-fake.mjs';

async function boot(t, scenario = 'f3-sessions') {
  const dir = trackTempDir(t, makeTempDir('opc-f3fake-'));
  const password = randomBytes(24).toString('hex');
  const fake = await startFake({ port: await pickFreePort(), password, scenario, stateFile: join(dir, 'state.json') });
  t.after(() => fake.close());
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  async function call(method, path, body) {
    const res = await fetch(`${fake.url}${path}`, {
      method,
      headers: { authorization: auth, 'x-opencode-directory': '/workspace', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: res.status, body: parsed?.data ?? parsed };
  }
  return { fake, call };
}

test('f3 fake: seeded sessions are listed newest first', async (t) => {
  const { call } = await boot(t);
  const res = await call('GET', '/api/session');
  assert.equal(res.status, 200);
  const ids = res.body.map((s) => s.id);
  assert.ok(ids.includes(SEED.session));
  assert.ok(ids.includes(SEED.userSession));
  assert.deepEqual(ids.slice(0, 2), [SEED.session, SEED.userSession]);
});

test('f3 fake: POST /api/session stores parentID, agent and model; parent query lists it', async (t) => {
  const { call } = await boot(t);
  const created = await call('POST', '/api/session', { parentID: SEED.session, title: 'OPC: sub: x', agent: 'general', model: { id: 'opencode-go/kimi-k3', providerID: 'omniroute-personal' }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] });
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^ses/);
  assert.equal(created.body.parentID, SEED.session);
  assert.equal(created.body.agent, 'general');
  assert.deepEqual(created.body.model, { id: 'opencode-go/kimi-k3', providerID: 'omniroute-personal' });
  const children = await call('GET', `/api/session?parentID=${SEED.session}`);
  assert.deepEqual(children.body.map((s) => s.id), [created.body.id]);
});

test('f3 fake: fork uses insertion order even when message ids sort differently', async (t) => {
  const { fake, call } = await boot(t);
  const messages = [
    userMessage(SEED.session, 'msg_z_last', 'one'),
    assistantMessage(SEED.session, 'msg_a_target', 'msg_z_last', 'two'),
    userMessage(SEED.session, 'msg_m_after', 'three'),
  ];
  fake.state.messages[SEED.session] = messages;
  const forked = await call('POST', `/api/session/${SEED.session}/fork`, { before: 'msg_a_target' });
  assert.deepEqual(forked.body.fork, { sessionID: SEED.session, boundary: 'msg_a_target' });
  const result = await call('GET', `/api/session/${forked.body.id}/message?order=asc`);
  assert.deepEqual(result.body.map((message) => message.id), ['msg_z_last']);
});

test('f3 fake: attach probe redacts password from argv log and creates private log', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-probe-'));
  const log = join(dir, 'probe.jsonl');
  const password = randomBytes(24).toString('hex');
  execFileSync(process.execPath, ['tests/fixtures/attach-probe.mjs', '--password', password, `https://user:${password}@localhost/path`], {
    env: { ...process.env, PROBE_LOG: log, OPENCODE_SERVER_PASSWORD: password, EXPECTED_SHA256: 'unused' },
  });
  const contents = readFileSync(log, 'utf8');
  assert.equal(contents.includes(password), false);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  // A URL with an empty user still carries a password that is not the server one.
  const other = randomBytes(12).toString('hex');
  execFileSync(process.execPath, ['tests/fixtures/attach-probe.mjs', `https://:${other}@localhost/path`], {
    env: { ...process.env, PROBE_LOG: log, OPENCODE_SERVER_PASSWORD: password, EXPECTED_SHA256: 'unused' },
  });
  assert.equal(readFileSync(log, 'utf8').includes(other), false);
});

test('group-slow permission reply rejects missing, non-pending, and always replies', async () => {
  const scenario = await loadScenario('group-slow');
  const handler = scenario.routes['POST /api/session/:id/permission/:requestID/reply'];
  const fake = { state: { permissions: { pending: { id: 'pending' } }, f3: { askSession: 'ses_ask', prompts: [] } }, emit() { throw new Error('must not emit'); } };
  assert.equal(handler(fake, { params: { id: 'ses_ask', requestID: 'missing' }, body: { decision: 'once' } }).status, 404);
  fake.state.permissions.pending = undefined;
  assert.equal(handler(fake, { params: { id: 'ses_ask', requestID: 'pending' }, body: { decision: 'once' } }).status, 404);
  fake.state.permissions.pending = { id: 'pending', sessionID: 'ses_ask' };
  assert.equal(handler(fake, { params: { id: 'ses_ask', requestID: 'pending' }, body: { decision: 'always' } }).status, 400);
});

test('f3 fake: fork copies only messages before the boundary', async (t) => {
  const { call } = await boot(t);
  const forked = await call('POST', `/api/session/${SEED.session}/fork`, { before: SEED.m3 });
  assert.equal(forked.status, 200);
  const msgs = await call('GET', `/api/session/${forked.body.id}/message?order=asc`);
  assert.deepEqual(msgs.body.map((m) => m.type), ['user', 'assistant']);
  const unknown = await call('POST', `/api/session/${SEED.session}/fork`, { before: 'msg_nope' });
  assert.equal(unknown.status, 400);
});

test('f3 fake: revert stage sets a diff, commit marks it, delete clears it', async (t) => {
  const { call } = await boot(t);
  const reverted = await call('POST', `/api/session/${SEED.session}/revert/stage`, { messageID: SEED.m3 });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.revert.messageID, SEED.m3);
  assert.match(reverted.body.revert.diff, /\+BETA/);
  const committed = await call('POST', `/api/session/${SEED.session}/revert/commit`);
  assert.equal(committed.body.revert.committed, true);
  const missing = await call('POST', `/api/session/${SEED.session}/revert/stage`, {});
  assert.equal(missing.status, 400);
  const restored = await call('DELETE', `/api/session/${SEED.session}/revert`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.revert, undefined);
});

test('f3 fake: compact uses the session model and appends a compaction message', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', '/api/session/ses_missing/compact')).status, 404);
  const switched = await call('POST', `/api/session/${SEED.session}/model`, { model: { providerID: 'omniroute-personal', id: 'opencode-go/qwen3.8-max' } });
  assert.equal(switched.status, 204);
  const res = await call('POST', `/api/session/${SEED.session}/compact`);
  assert.equal(res.status, 204);
  const msgs = await call('GET', `/api/session/${SEED.session}/message?order=asc`);
  const compaction = msgs.body.findLast((m) => m.type === 'assistant');
  assert.equal(compaction.agent, 'compaction');
  assert.equal(compaction.model.id, 'opencode-go/qwen3.8-max');
});

test('f3 fake: command requires name and string text, answers through the turn', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', `/api/session/${SEED.session}/command`, { name: 'echo' })).status, 400);
  assert.equal((await call('POST', `/api/session/${SEED.session}/command`, { name: 'nope', text: '' })).status, 400);
  assert.equal((await call('POST', `/api/session/${SEED.session}/command`, { command: 'echo', arguments: 'a b' })).status, 400);
  const res = await call('POST', `/api/session/${SEED.session}/command`, { name: 'echo', text: 'a b' });
  assert.equal(res.status, 204);
  let answer;
  for (let attempt = 0; attempt < 100 && !answer; attempt += 1) {
    const messages = await call('GET', `/api/session/${SEED.session}/message?order=asc`);
    answer = messages.body.findLast((m) => m.type === 'assistant' && m.content?.[0]?.text?.startsWith('COMANDO'));
    if (!answer) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(answer, 'the command turn must answer');
  assert.equal(answer.model.id, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(answer.content[0].text, 'COMANDO echo ARGUMENTOS[a b]');
});

test('f3 fake: diff (with and without messageID) and catalogs', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('GET', `/api/session/${SEED.session}/diff`)).body.length, 1);
  const perMessage = await call('GET', `/api/session/${SEED.session}/diff?messageID=${SEED.m3}`);
  assert.deepEqual(perMessage.body.map((d) => d.file), ['notes.txt', 'extra.txt']);
  const providers = await call('GET', '/api/provider');
  assert.deepEqual(providers.body.map((p) => p.id), ['omniroute-personal', 'omniroute-work']);
  assert.ok((await call('GET', '/api/agent')).body.some((a) => a.name === 'explore' && a.mode === 'subagent'));
  assert.ok((await call('GET', '/api/command')).body.some((c) => c.name === 'pinned-model'));
});

test('f3 fake: children scenario seeds two children of the seed session', async (t) => {
  const { call } = await boot(t, 'children');
  const res = await call('GET', `/api/session?parentID=${SEED.session}`);
  assert.equal(res.body.length, 2);
});
