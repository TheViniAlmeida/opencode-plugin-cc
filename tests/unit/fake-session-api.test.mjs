import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import retryStatus from '../fixtures/scenarios/retry-status.mjs';
import structured from '../fixtures/scenarios/structured.mjs';
import structuredError from '../fixtures/scenarios/structured-error.mjs';
import subagent from '../fixtures/scenarios/subagent-mode-refused.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const MODEL = { id: 'model', providerID: 'provider' };
const PERMISSIONS = [{ action: '*', resource: '*', effect: 'deny' }];
function fakeWithScenario(scenario) {
  const fake = { state: {}, scenario, events: [], persist() {}, emit(event) { this.events.push(event); } };
  const api = installSessionApi(fake);
  return { fake, api };
}

test('interruption during retry leaves one idle interrupted and no assistant', async () => {
  const { fake } = fakeWithScenario(retryStatus);
  const session = fake.createSession({ title: 'OPC: retry', model: MODEL, permissions: PERMISSIONS });
  fake.setStatus(session.id, { type: 'busy' });
  const scenario = retryStatus.onPrompt(fake, session.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.abortSession(session.id);
  await scenario;
  const messages = fake.state.messages[session.id];
  assert.deepEqual(messages.map((m) => [m.type, m.outcome]), [['idle', 'interrupted']]);
  assert.equal(fake.state.statuses[session.id], undefined);
  assert.equal(fake.events.filter((e) => e.type === 'session.execution.interrupted').length, 1);
});

test('retry keeps an empty pending assistant with matching retry metadata', async () => {
  const { fake } = fakeWithScenario(retryStatus);
  const session = fake.createSession({ model: MODEL, permissions: PERMISSIONS });
  const pending = retryStatus.onPrompt(fake, session.id);
  const scheduled = fake.events.find((e) => e.type === 'session.retry.scheduled');
  const assistant = fake.state.messages[session.id][0];
  assert.equal(assistant.type, 'assistant');
  assert.deepEqual(assistant.content, []);
  assert.equal(assistant.id, scheduled.data.assistantMessageID);
  assert.deepEqual(assistant.retry, { attempt: scheduled.data.attempt, at: scheduled.data.at, error: scheduled.data.error });
  fake.abortSession(session.id);
  await pending;
});

test('scenario error logs are single-line, redacted, and omit stack traces', async () => {
  const secret = 'fake-api-secret-123456';
  registerSecret(secret);
  const { api, fake } = fakeWithScenario({ onPrompt: async () => { throw new Error(`falha com ${secret}\ndetalhes da pilha`); } });
  const session = fake.createSession({ title: 'OPC: t', model: MODEL, permissions: PERMISSIONS });
  const originalWrite = process.stderr.write;
  let logged = '';
  process.stderr.write = (line) => { logged += line; return true; };
  try {
    api.handle('POST', `/api/session/${session.id}/prompt`, new URLSearchParams(), { text: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(logged, 'Erro no cenário do servidor falso: falha com **…\n');
  assert.equal(logged.includes('Error:'), false);
  assert.equal(fake.state.statuses[session.id], undefined);
  assert.equal(fake.state.messages[session.id].at(-1).outcome, 'failed');
  assert.equal(fake.events.at(-1).type, 'session.execution.failed');
});

test('structured scenarios use ordinary V2 assistant text', async () => {
  for (const [scenario, expected] of [[structured, '{"verdict":"approve","count":3}'], [structuredError, 'raw text answer that is not valid JSON']]) {
    const { fake } = fakeWithScenario(scenario);
    const session = fake.createSession({ model: MODEL, permissions: PERMISSIONS });
    await scenario.onPrompt(fake, session.id);
    assert.equal(fake.state.messages[session.id][0].content[0].text, expected);
    assert.equal(fake.state.messages[session.id].at(-1).outcome, 'succeeded');
  }
});

test('subagent scenario uses V2 tool and inherited child session', async () => {
  const { fake } = fakeWithScenario(subagent);
  const parent = fake.createSession({ model: MODEL, permissions: PERMISSIONS });
  await subagent.onPrompt(fake, parent.id, { text: 'investigate', agents: ['explore'] });
  const child = Object.values(fake.state.sessions).find((s) => s.parentID === parent.id);
  assert.deepEqual(child.model, MODEL);
  assert.deepEqual(child.permissions, PERMISSIONS);
  assert.deepEqual(fake.state.messages[parent.id][0].content[0].state.input, { agent: 'explore', description: 'Subagent task', prompt: 'investigate' });
  assert.equal(fake.state.messages[parent.id][0].content[0].name, 'subagent');
});
