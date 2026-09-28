import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { loadScenario, startFake } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { F3_MODELS, SEED, userMessage, assistantMessage } from '../fixtures/f3-fake.mjs';

async function boot(t, scenario = 'f3-sessions') {
  const dir = trackTempDir(t, makeTempDir('opc-f3fake-'));
  const password = randomBytes(24).toString('hex');
  const fake = await startFake({ port: await pickFreePort(), password, scenario, stateFile: join(dir, 'state.json') });
  t.after(() => fake.close());
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  async function call(method, path, body) {
    const res = await fetch(`${fake.url}${path}`, {
      method,
      headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { fake, call };
}

test('f3 fake: seeded sessions are listed newest first', async (t) => {
  const { call } = await boot(t);
  const res = await call('GET', '/session');
  assert.equal(res.status, 200);
  const ids = res.body.map((s) => s.id);
  assert.ok(ids.includes(SEED.session));
  assert.ok(ids.includes(SEED.userSession));
  assert.deepEqual(ids.slice(0, 2), [SEED.session, SEED.userSession]);
});

test('f3 fake: POST /session stores parentID, agent and model; children lists it', async (t) => {
  const { call } = await boot(t);
  const created = await call('POST', '/session', { parentID: SEED.session, title: 'OPC: sub: x', agent: 'general', model: { id: 'opencode-go/kimi-k3', providerID: 'omniroute-personal' } });
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^ses/);
  assert.equal(created.body.parentID, SEED.session);
  assert.equal(created.body.agent, 'general');
  assert.deepEqual(created.body.model, { id: 'opencode-go/kimi-k3', providerID: 'omniroute-personal' });
  const children = await call('GET', `/session/${SEED.session}/children`);
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
  const forked = await call('POST', `/session/${SEED.session}/fork`, { messageID: 'msg_a_target' });
  const result = await call('GET', `/session/${forked.body.id}/message`);
  assert.deepEqual(result.body.map((message) => message.info.id), ['msg_z_last']);
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
  const handler = scenario.routes['POST /permission/:id/reply'];
  const fake = { state: { permissions: { pending: { id: 'pending' } }, f3: { askSession: 'ses_ask', prompts: [] } }, emit() { throw new Error('must not emit'); } };
  assert.equal(handler(fake, { params: { id: 'missing' }, body: { reply: 'once' } }).status, 400);
  fake.state.permissions.pending = undefined;
  assert.equal(handler(fake, { params: { id: 'pending' }, body: { reply: 'once' } }).status, 400);
  fake.state.permissions.pending = { id: 'pending' };
  assert.equal(handler(fake, { params: { id: 'pending' }, body: { reply: 'always' } }).status, 400);
});

test('f3 fake: fork copies only messages before messageID', async (t) => {
  const { call } = await boot(t);
  const forked = await call('POST', `/session/${SEED.session}/fork`, { messageID: SEED.m3 });
  assert.equal(forked.status, 200);
  const msgs = await call('GET', `/session/${forked.body.id}/message`);
  assert.deepEqual(msgs.body.map((m) => m.info.role), ['user', 'assistant']);
  const unknown = await call('POST', `/session/${SEED.session}/fork`, { messageID: 'msg_nope' });
  assert.equal(unknown.status, 400);
});

test('f3 fake: revert sets session.revert with a diff; unrevert clears it', async (t) => {
  const { call } = await boot(t);
  const reverted = await call('POST', `/session/${SEED.session}/revert`, { messageID: SEED.m3 });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.revert.messageID, SEED.m3);
  assert.match(reverted.body.revert.diff, /\+BETA/);
  const missing = await call('POST', `/session/${SEED.session}/revert`, {});
  assert.equal(missing.status, 400);
  const restored = await call('POST', `/session/${SEED.session}/unrevert`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.revert, undefined);
});

test('f3 fake: summarize requires providerID and modelID', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', `/session/${SEED.session}/summarize`, {})).status, 400);
  const res = await call('POST', `/session/${SEED.session}/summarize`, { providerID: 'omniroute-personal', modelID: 'opencode-go/qwen3.8-max' });
  assert.equal(res.status, 200);
  assert.equal(res.body, true);
  const msgs = await call('GET', `/session/${SEED.session}/message`);
  assert.equal(msgs.body.at(-1).info.summary, true);
});

test('f3 fake: command requires command and string arguments, answers synchronously', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', `/session/${SEED.session}/command`, { command: 'echo' })).status, 400);
  assert.equal((await call('POST', `/session/${SEED.session}/command`, { command: 'nope', arguments: '' })).status, 400);
  const res = await call('POST', `/session/${SEED.session}/command`, { command: 'echo', arguments: 'a b', model: F3_MODELS.qwen });
  assert.equal(res.status, 200);
  assert.equal(res.body.info.modelID, 'opencode-go/qwen3.8-max');
  assert.equal(res.body.parts[0].text, 'COMMAND echo ARGS[a b]');
});

test('f3 fake: diff (with and without messageID), todo, dispose and catalogs', async (t) => {
  const { fake, call } = await boot(t);
  assert.equal((await call('GET', `/session/${SEED.session}/diff`)).body.length, 1);
  const perMessage = await call('GET', `/session/${SEED.session}/diff?messageID=${SEED.m3}`);
  assert.deepEqual(perMessage.body.map((d) => d.file), ['notes.txt', 'extra.txt']);
  assert.equal((await call('GET', `/session/${SEED.session}/todo`)).body.length, 2);
  assert.equal((await call('POST', '/instance/dispose')).body, true);
  assert.equal(fake.state.f3.disposed, 1);
  const providers = await call('GET', '/provider');
  assert.deepEqual(providers.body.connected, ['omniroute-personal', 'omniroute-work']);
  assert.ok((await call('GET', '/agent')).body.some((a) => a.name === 'explore' && a.mode === 'subagent'));
  assert.ok((await call('GET', '/command')).body.some((c) => c.name === 'pinned-model'));
});

test('f3 fake: children scenario seeds two children of the seed session', async (t) => {
  const { call } = await boot(t, 'children');
  const res = await call('GET', `/session/${SEED.session}/children`);
  assert.equal(res.body.length, 2);
});
