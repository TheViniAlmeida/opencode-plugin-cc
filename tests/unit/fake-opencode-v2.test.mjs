import assert from 'node:assert/strict';
import test from 'node:test';
import { startFake, safeRequestBody } from '../fixtures/fake-opencode.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import { checkImportShape } from '../fixtures/fake-import.mjs';
import { assertShape, loadContractSample } from '../fixtures/contract-shapes.mjs';
import { loadFixtureData } from '../fixtures/fake-opencode.mjs';
import { withF3, seedSession, SEED } from '../fixtures/f3-fake.mjs';

const RULES = [{ action: '*', resource: '*', effect: 'deny' }];
const MODEL = { providerID: 'p', id: 'm' };

test('fake V2 serves /api with auth, JSON envelopes and the SPA fallback', async (t) => {
  const fake = await startFake({ password: 'pw' });
  t.after(() => fake.close());
  const auth = { authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}` };
  assert.equal((await fetch(`${fake.url}/api/info`)).status, 401);
  const info = await (await fetch(`${fake.url}/api/info`, { headers: auth })).json();
  assert.equal(info.version, '2.0.22');
  const spa = await fetch(`${fake.url}/global/health`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-type'), /text\/html/);
  const created = await (await fetch(`${fake.url}/api/session`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-opencode-directory': '/w' }, body: JSON.stringify({ title: 'OPC: t', model: MODEL, permissions: RULES }) })).json();
  assert.match(created.data.id, /^ses_/);
  assert.equal(fake.state.requests.at(-1).directory, '/w');
});

function memoryFake() {
  const fake = { state: {}, scenario: {}, events: [], persist() {}, emit(event) { this.events.push(event); } };
  installSessionApi(fake);
  return fake;
}

test('fake V2 tool call and final text occupy separate assistant messages', async () => {
  const fake = memoryFake();
  const session = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  await fake.emitTurn(session.id, { text: 'ok', tools: [{ tool: 'read', input: { path: 'a' } }], delayMs: 1 });
  const types = fake.events.map((e) => e.type);
  assert.ok(types.includes('session.tool.success'));
  assert.equal(types.at(-1), 'session.execution.succeeded');
  assert.ok(fake.events.every((e) => e.data && !('properties' in e)));
  assert.deepEqual(fake.state.messages[session.id].map((m) => m.type), ['assistant', 'assistant', 'idle']);
  assert.deepEqual(fake.state.messages[session.id].slice(0, 2).map((m) => m.finish), ['tool-calls', 'stop']);
  assert.deepEqual(fake.state.messages[session.id][0].content.map((c) => c.type), ['tool']);
  assert.deepEqual(fake.state.messages[session.id][1].content.map((c) => c.type), ['text']);
});

test('fake V2 child sessions inherit the parent permissions and model', () => {
  const fake = memoryFake();
  const parent = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  const child = fake.createChildSession(parent.id, { agent: 'explore' });
  assert.deepEqual(child.permissions, RULES);
  assert.deepEqual(child.model, MODEL);
  assert.equal(child.parentID, parent.id);
});

test('fake V2 failExecution leaves no assistant and an idle failed', () => {
  const fake = memoryFake();
  const session = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: RULES }, '/w');
  fake.failExecution(session.id, { type: 'provider.no-route', message: 'Model unavailable: p/m' });
  assert.deepEqual(fake.state.messages[session.id].map((m) => [m.type, m.outcome ?? null]), [['idle', 'failed']]);
  assert.equal(fake.events.at(-1).type, 'session.execution.failed');
});

test('fake V2 prompt is idempotent and PATCH replaces permissions', async () => {
  const fake = memoryFake();
  const api = installSessionApi(fake);
  const session = fake.createSession({ model: MODEL, permissions: RULES }, '/w');
  const promptID = 'msg_123456789abcABCDEFGHIJKLMN';
  const prompt = { id: promptID, text: 'Olá' };
  const route = `/api/session/${session.id}/prompt`;
  const first = api.handle('POST', route, new URLSearchParams(), prompt).body.data;
  const second = api.handle('POST', route, new URLSearchParams(), prompt).body.data;
  assert.equal(first.id, second.id);
  assert.equal(fake.state.messages[session.id].filter((m) => m.id === promptID).length, 1);
  const replacement = [{ action: 'read', resource: '*', effect: 'allow' }];
  assert.equal(api.handle('PATCH', `/api/session/${session.id}`, new URLSearchParams(), { permissions: replacement }).status, 204);
  assert.deepEqual(session.permissions, replacement);
});

test('fake V2 permission and form replies resolve their pending promises', async () => {
  const fake = memoryFake();
  const api = installSessionApi(fake);
  const session = fake.createSession({ model: MODEL, permissions: RULES }, '/w');
  const permission = fake.askPermission(session.id, { action: 'shell', resources: ['npm test'] });
  const requestID = Object.keys(fake.state.permissions)[0];
  assert.equal(api.handle('POST', `/api/session/${session.id}/permission/${requestID}/reply`, new URLSearchParams(), { decision: 'once' }).status, 204);
  assert.equal(await permission, 'once');
  const form = fake.askQuestion(session.id, [{ key: 'q0', title: 'Opção', description: '', type: 'string', options: [], custom: true }]);
  const formID = Object.keys(fake.state.forms)[0];
  const answer = { q0: 'A' };
  assert.equal(api.handle('POST', `/api/session/${session.id}/form/${formID}/reply`, new URLSearchParams(), { answer }).status, 204);
  assert.deepEqual(await form, answer);
  assert.equal(fake.events.some((e) => e.type === 'form.created' && e.data.form.id === formID), true);
});

test('fake V2 import oracle accepts recorded V2 and rejects a V1 message', () => {
  const sample = loadContractSample('export.json');
  assert.deepEqual(checkImportShape(sample), []);
  const old = structuredClone(sample);
  old.messages[0] = { info: { role: 'user' }, parts: [] };
  assert.ok(checkImportShape(old).length > 0);
});

test('fake catalogs retain sensitive V2 settings for consumer redaction', () => {
  for (const provider of loadFixtureData('provider.json')) {
    assertShape('provider', provider);
    assert.equal(typeof provider.settings.apiKey, 'string');
  }
  for (const agent of loadFixtureData('agent.json')) assertShape('agent', agent);
  for (const model of loadFixtureData('model.json')) {
    assertShape('model', model);
    assert.equal(typeof model.settings.apiKey, 'string');
    assert.equal(model.capabilities.tools, true);
    assert.equal('toolcall' in model.capabilities, false);
  }
});

test('request history masks credential keys at any depth and keeps asserted content', () => {
  const body = { text: 'short', nested: { apiKey: 'key-value', input: ['kept', { password: 'hidden', note: 'kept-note' }] }, headers: { Authorization: 'Basic abc' } };
  const safe = safeRequestBody(body);
  const json = JSON.stringify(safe);
  for (const leaked of ['key-value', 'hidden', 'Basic abc']) assert.equal(json.includes(leaked), false, leaked);
  assert.equal(safe.text, 'short');
  assert.deepEqual(safe.nested.input, ['kept', { password: '[REDACTED]', note: 'kept-note' }]);
  assert.equal(JSON.stringify(body).includes('hidden'), true);
});

test('fake prompt response follows recorded V2 payload and delivery shape', () => {
  const fake = memoryFake();
  const api = installSessionApi(fake);
  const session = fake.createSession({ model: MODEL, permissions: RULES }, '/w');
  const data = api.handle('POST', `/api/session/${session.id}/prompt`, new URLSearchParams(), { text: 'hi', delivery: 'steer' }).body.data;
  assert.equal(data.sessionID, session.id);
  assert.deepEqual(data.payload, { text: 'hi' });
  assert.equal(data.delivery, 'steer');
  assert.equal('text' in data, false);
  assert.equal(fake.state.messages[session.id][0].text, 'hi');
});

test('F3 V2 seed, children and fork use flat messages', () => {
  const fake = memoryFake();
  const scenario = withF3({ setup: seedSession });
  scenario.setup(fake);
  const child = fake.createChildSession(SEED.session, { agent: 'explore' });
  assert.equal(child.parentID, SEED.session);
  assert.deepEqual(child.permissions, fake.state.sessions[SEED.session].permissions);
  const forked = scenario.routes['POST /api/session/:id/fork'](fake, { params: { id: SEED.session }, body: { before: SEED.m3 } });
  assert.equal(forked.status, 200);
  assert.deepEqual(fake.state.messages[forked.body.data.id].map((m) => m.type), ['user', 'assistant']);
});

test('F3 V2 revert, compact and command routes use their V2 paths', () => {
  const fake = memoryFake();
  const scenario = withF3({ setup: seedSession });
  scenario.setup(fake);
  const params = { id: SEED.session };
  const stage = scenario.routes['POST /api/session/:id/revert/stage'](fake, { params, body: { messageID: SEED.m3 } });
  assert.equal(stage.body.data.revert.messageID, SEED.m3);
  const committed = scenario.routes['POST /api/session/:id/revert/commit'](fake, { params });
  assert.equal(committed.body.data.revert.committed, true);
  assert.equal(scenario.routes['DELETE /api/session/:id/revert'](fake, { params }).body.data.revert, undefined);
  assert.equal(scenario.routes['POST /api/session/:id/compact'](fake, { params, body: { providerID: 'p', modelID: 'm' } }).status, 204);
  assert.equal(scenario.routes['POST /api/session/:id/command'](fake, { params, body: { name: 'echo', text: 'a b' } }).status, 204);
  // V2 answers 204 and the result arrives later through the turn; only the user message exists right away.
  assert.equal(fake.state.messages[SEED.session].at(-1).type, 'user');
});
