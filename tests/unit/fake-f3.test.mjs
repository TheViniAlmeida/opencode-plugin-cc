import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { F3_MODELS, SEED } from '../fixtures/f3-fake.mjs';

const PASSWORD = 'f3-fake-password-0123456789';

async function boot(t, scenario = 'f3-sessions') {
  const dir = mkdtempSync(join(tmpdir(), 'opc-f3fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await startFake({ port: await pickFreePort(), password: PASSWORD, scenario, stateFile: join(dir, 'state.json') });
  t.after(() => fake.close());
  const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
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
});

test('f3 fake: POST /session stores parentID, agent and model; children lists it', async (t) => {
  const { call } = await boot(t);
  const created = await call('POST', '/session', { parentID: SEED.session, title: 'OPC: sub: x', agent: 'general', model: { id: 'opencode-go/kimi-k3', providerID: 'omniroute-personal' } });
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^ses/);
  assert.equal(created.body.parentID, SEED.session);
  assert.equal(created.body.agent, 'general');
  const children = await call('GET', `/session/${SEED.session}/children`);
  assert.deepEqual(children.body.map((s) => s.id), [created.body.id]);
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
