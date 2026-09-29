import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const scenarioUrl = (name) => new URL(`../fixtures/scenarios/${name}.mjs`, import.meta.url);
const P = 'omniroute-personal';
const FAST = `${P}/opencode-go/deepseek-v4.1-flash`;
const K3 = `${P}/opencode-go/kimi-k3`;

function body(full, extra = {}) {
  const [providerID, ...rest] = full.split('/');
  return { model: { providerID, modelID: rest.join('/') }, parts: [{ type: 'text', text: 'oi' }], ...extra };
}

function stubFake() {
  const calls = { turns: [], events: [] };
  return {
    calls,
    state: { requests: [] },
    emitTurn(sessionID, opts) { calls.turns.push({ sessionID, ...opts }); },
    emit(event) { calls.events.push(event); },
  };
}

function withFailModel(t, value) {
  const previous = process.env.FAKE_FAIL_MODELS;
  process.env.FAKE_FAIL_MODELS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_FAIL_MODELS;
    else process.env.FAKE_FAIL_MODELS = previous;
  });
}

test('isFailingModel honours FAKE_FAIL_MODELS (comma list) and ignores bodies without a model', async () => {
  const { isFailingModel } = await import(`${scenarioUrl('_model-select')}?case=list`);
  const env = { FAKE_FAIL_MODELS: `${FAST}, ${P}/other` };
  assert.equal(isFailingModel(body(FAST), env), true);
  assert.equal(isFailingModel(body(K3), env), false);
  assert.equal(isFailingModel({}, env), false);
});

test('without FAKE_FAIL_MODELS the first model seen is the failing one', async () => {
  const { isFailingModel } = await import(`${scenarioUrl('_model-select')}?case=first`);
  assert.equal(isFailingModel(body(K3), {}), true);
  assert.equal(isFailingModel(body(FAST), {}), false);
  assert.equal(isFailingModel(body(K3), {}), true);
});

test('successTurn returns review-shaped structured output when a format is requested', async () => {
  const { successTurn } = await import(`${scenarioUrl('_model-select')}?case=success`);
  assert.deepEqual(successTurn(body(K3, { format: { type: 'json_schema' } })).structured, { verdict: 'approve', summary: 'Sem achados relevantes.', findings: [], next_steps: [] });
  assert.match(successTurn(body(K3)).text, /resposta falsa de omniroute-personal\/opencode-go\/kimi-k3/);
});

test('model-429 fails the selected model with a retryable APIError 429', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('model-429'));
  const fake = stubFake();
  scenario.onPromptAsync(fake, 'ses_1', body(FAST));
  scenario.onPromptAsync(fake, 'ses_2', body(K3));
  assert.deepEqual(fake.calls.turns[0].error, { name: 'APIError', data: { message: 'Limite de requisições excedido (429 falso)', statusCode: 429, isRetryable: true } });
  assert.equal(fake.calls.turns[1].error, undefined);
  assert.equal(fake.calls.turns[1].sessionID, 'ses_2');
});

test('model-fatal fails the selected model with ProviderAuthError', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('model-fatal'));
  const fake = stubFake();
  scenario.onPromptAsync(fake, 'ses_1', body(FAST));
  assert.equal(fake.calls.turns[0].error.name, 'ProviderAuthError');
  assert.equal(fake.calls.turns[0].error.data.providerID, P);
});

test('write-then-fail completes an edit tool and then fails with a retryable APIError', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('write-then-fail'));
  const fake = stubFake();
  scenario.onPromptAsync(fake, 'ses_1', body(FAST));
  const turn = fake.calls.turns[0];
  assert.equal(turn.tools[0].tool, 'edit');
  assert.equal(turn.tools[0].input.filePath, 'src/app.js');
  assert.equal(turn.error.name, 'APIError');
  assert.equal(turn.error.data.isRetryable, true);
});

test('retry-over-cap emits increasing retry statuses until the session is aborted', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('retry-over-cap'));
  const fake = stubFake();
  scenario.onPromptAsync(fake, 'ses_1', body(FAST));
  await delay(170);
  const retries = fake.calls.events.filter((e) => e.properties.status.type === 'retry').map((e) => e.properties.status);
  assert.ok(retries.length >= 2, `esperados >= 2 eventos de retry, recebidos ${retries.length}`);
  retries.forEach((s, i) => assert.equal(s.attempt, i + 1));
  assert.ok(retries[1].next > retries[0].next);
  fake.state.requests.push({ method: 'POST', path: '/session/ses_1/abort', body: null });
  await delay(120);
  assert.equal(fake.calls.turns.length, 1);
  assert.equal(fake.calls.turns[0].error.name, 'MessageAbortedError');
  const count = fake.calls.events.length;
  await delay(100);
  assert.equal(fake.calls.events.length, count, 'nenhum evento após o cancelamento');
});

test('retry-over-cap lets non-selected models succeed', async (t) => {
  withFailModel(t, FAST);
  const { default: scenario } = await import(scenarioUrl('retry-over-cap'));
  const fake = stubFake();
  scenario.onPromptAsync(fake, 'ses_2', body(K3));
  assert.equal(fake.calls.events.length, 0);
  assert.equal(fake.calls.turns[0].error, undefined);
});
