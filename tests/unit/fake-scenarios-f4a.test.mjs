import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';

const scenarioUrl = (name) => new URL(`../fixtures/scenarios/${name}.mjs`, import.meta.url);
const P = 'omniroute-personal';
const FAST = `${P}/opencode-go/deepseek-v4.1-flash`;
const K3 = `${P}/opencode-go/kimi-k3`;
const RULES = [{ action: '*', resource: '*', effect: 'deny' }];
const sessionBody = (full) => { const [providerID, ...rest] = full.split('/'); return { model: { providerID, id: rest.join('/') }, permissions: RULES }; };
function stubFake() {
  const calls = { turns: [], events: [] };
  const fake = { calls, state: { sessions: {}, aborts: [] },
    emitTurn(sessionID, opts) { calls.turns.push({ sessionID, ...opts }); },
    failExecution(sessionID, error) { calls.turns.push({ sessionID, error }); },
    event(type, data) { calls.events.push({ type, data }); },
    setStatus() {} };
  fake.state.sessions.ses_1 = sessionBody(FAST);
  fake.state.sessions.ses_2 = sessionBody(K3);
  return fake;
}
function realFake(scenario) {
  const fake = { state: {}, scenario, events: [], persist() {}, emit(event) { this.events.push(event); } };
  const api = installSessionApi(fake);
  return { fake, api };
}
function withFailModel(t, value) {
  const previous = process.env.FAKE_FAIL_MODELS;
  process.env.FAKE_FAIL_MODELS = value;
  t.after(() => { if (previous === undefined) delete process.env.FAKE_FAIL_MODELS; else process.env.FAKE_FAIL_MODELS = previous; });
}

test('isFailingModel honours FAKE_FAIL_MODELS and ignores sessions without a model', async () => {
  const { isFailingModel } = await import(`${scenarioUrl('_model-select')}?case=list`);
  const env = { FAKE_FAIL_MODELS: `${FAST}, ${P}/other` };
  assert.equal(isFailingModel(sessionBody(FAST), env), true);
  assert.equal(isFailingModel(sessionBody(K3), env), false);
  assert.equal(isFailingModel({}, env), false);
});

test('without FAKE_FAIL_MODELS the first model seen is the failing one', async () => {
  const { isFailingModel } = await import(`${scenarioUrl('_model-select')}?case=first`);
  assert.equal(isFailingModel(sessionBody(K3), {}), true);
  assert.equal(isFailingModel(sessionBody(FAST), {}), false);
  assert.equal(isFailingModel(sessionBody(K3), {}), true);
});

test('successTurn returns V2 text', async () => {
  const { successTurn } = await import(`${scenarioUrl('_model-select')}?case=success`);
  assert.equal(successTurn(sessionBody(K3)).structured, undefined);
  assert.match(successTurn(sessionBody(K3)).text, /resposta falsa de omniroute-personal\/opencode-go\/kimi-k3/);
});

test('model-429 fails the selected model with a provider rate limit', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('model-429'));
  const fake = stubFake();
  scenario.onPrompt(fake, 'ses_1', { text: 'oi' });
  scenario.onPrompt(fake, 'ses_2', { text: 'oi' });
  assert.equal(fake.calls.turns[0].error.type, 'provider.rate-limit');
  assert.equal(fake.calls.turns[1].error, undefined);
});

test('failing scenarios end with idle failed and no default success text', async (t) => {
  withFailModel(t, FAST);
  for (const name of ['model-429', 'model-fatal', 'write-then-fail']) {
    const { default: scenario } = await import(scenarioUrl(name));
    const { fake } = realFake(scenario);
    const session = fake.createSession({ ...sessionBody(FAST), title: 'OPC: t' });
    await scenario.onPrompt(fake, session.id, { text: 'oi' });
    await delay(name === 'write-then-fail' ? 130 : 90);
    const messages = fake.state.messages[session.id];
    assert.equal(messages.at(-1).outcome, 'failed', name);
    assert.equal(messages.some((m) => m.content?.some((part) => part.type === 'text')), false, name);
    if (name === 'write-then-fail') assert.equal(messages.find((m) => m.type === 'assistant')?.content[0]?.name, 'edit');
  }
});

test('model-fatal fails the selected model with provider auth error', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('model-fatal'));
  const fake = stubFake();
  scenario.onPrompt(fake, 'ses_1', { text: 'oi' });
  assert.equal(fake.calls.turns[0].error.type, 'provider.auth');
});

test('write-then-fail completes an edit tool before failing', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('write-then-fail'));
  const fake = stubFake();
  scenario.onPrompt(fake, 'ses_1', { text: 'oi' });
  const turn = fake.calls.turns[0];
  assert.equal(turn.tools[0].tool, 'edit');
  assert.equal(turn.tools[0].input.filePath, 'src/app.js');
  assert.equal(turn.error.type, 'provider.transport');
});

test('retry-over-cap emits increasing retry scheduled events until interruption', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('retry-over-cap'));
  const fake = stubFake();
  scenario.onPrompt(fake, 'ses_1', { text: 'oi' });
  await delay(170);
  const retries = fake.calls.events.filter((e) => e.type === 'session.retry.scheduled').map((e) => e.data);
  assert.ok(retries.length >= 2);
  retries.forEach((r, i) => assert.equal(r.attempt, i + 1));
  assert.ok(retries[1].at > retries[0].at);
  fake.state.aborts.push('ses_1');
  await delay(120);
  const count = fake.calls.events.length;
  await delay(100);
  assert.equal(fake.calls.events.length, count);
});

test('retry-over-cap exposes running active status and interrupt finishes idle', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('retry-over-cap'));
  const { fake, api } = realFake(scenario);
  const session = fake.createSession({ ...sessionBody(FAST), title: 'OPC: t' });
  scenario.onPrompt(fake, session.id, { text: 'oi' });
  await delay(110);
  assert.equal(api.handle('GET', '/api/session/active', new URLSearchParams(), {}).body.data[session.id].type, 'running');
  assert.equal(api.handle('POST', `/api/session/${session.id}/interrupt`, new URLSearchParams(), {}).body.interrupted, true);
  await delay(150);
  assert.equal(fake.state.statuses[session.id], undefined);
  assert.equal(fake.state.messages[session.id].at(-1).outcome, 'interrupted');
});

test('retry-over-cap lets non-selected models succeed', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('retry-over-cap'));
  const fake = stubFake();
  scenario.onPrompt(fake, 'ses_2', { text: 'oi' });
  assert.equal(fake.calls.events.length, 0);
  assert.equal(fake.calls.turns[0].error, undefined);
});
