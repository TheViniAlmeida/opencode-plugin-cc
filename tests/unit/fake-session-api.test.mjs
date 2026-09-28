import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import retryStatus from '../fixtures/scenarios/retry-status.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

function fakeWithScenario(scenario) {
  const fake = { state: {}, scenario, events: [], persist() {}, emit(event) { this.events.push(event); } };
  const api = installSessionApi(fake);
  return { fake, api };
}

test('aborting during retry stops recovery, emits one abort error, and leaves the session idle', async () => {
  const { fake } = fakeWithScenario(retryStatus);
  const session = fake.createSession({ title: 'retry abort' });
  fake.setStatus(session.id, { type: 'busy' });
  const scenario = retryStatus.onPromptAsync(fake, session.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.abortSession(session.id);
  await scenario;
  await new Promise((resolve) => setTimeout(resolve, 520));
  const messages = fake.state.messages[session.id];
  assert.equal(messages.filter((m) => m.info.error?.name === 'MessageAbortedError').length, 1);
  assert.equal(messages.filter((m) => m.info.role === 'assistant').length, 1);
  assert.equal(fake.state.statuses[session.id], undefined);
});

test('scenario error logs are single-line, redacted, and omit stack traces', async () => {
  const secret = 'fake-api-secret-123456';
  registerSecret(secret);
  const { api, fake } = fakeWithScenario({ onPromptAsync: async () => { throw new Error(`failed with ${secret}\nstack details`); } });
  const session = fake.createSession();
  const originalWrite = process.stderr.write;
  let logged = '';
  process.stderr.write = (line) => { logged += line; return true; };
  try {
    api.handle('POST', `/session/${session.id}/prompt_async`, new URLSearchParams(), { parts: [{ type: 'text', text: 'go' }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(logged, 'fake-opencode scenario error: failed with *** stack details\n');
  assert.equal(logged.includes('Error:'), false);
});
