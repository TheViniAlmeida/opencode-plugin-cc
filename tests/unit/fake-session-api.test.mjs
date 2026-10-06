import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import retryStatus from '../fixtures/scenarios/retry-status.mjs';
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
});
