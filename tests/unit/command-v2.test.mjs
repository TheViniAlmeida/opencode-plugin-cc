import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { F3_SESSION_ROUTES } from '../fixtures/f3-fake.mjs';

test('runTurn sends the V2 command and waits for its execution event', async () => {
  let onEvent;
  const messages = [{ id: 'msg_old', type: 'idle', outcome: 'succeeded' }];
  const api = {
    getSession: async () => ({ agent: 'build', model: { providerID: 'p', id: 'm' } }),
    messages: async (_id, { limit }) => messages.slice(0, limit),
    runCommand: async (_id, body) => {
      assert.deepEqual(body, { name: 'echo', text: 'hi' });
      messages.push({ id: 'msg_user', type: 'user', text: '/echo hi' },
        { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: 'ready' }] },
        { id: 'msg_idle', type: 'idle', outcome: 'succeeded' });
      queueMicrotask(() => onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } }));
    },
    diff: async () => [],
  };
  const hub = { track: (_id, callback) => { onEvent = callback; return () => {}; }, onReconnect: () => () => {} };
  const result = await runTurn({ api, hub, request: { sessionID: 'ses_test', model: { providerID: 'p', modelID: 'm' }, command: { name: 'echo', text: 'hi' }, timeoutMs: 1000 } });
  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'ready');
  assert.equal(result.messageID, 'msg_user');
});

test('runTurn preserves a V2 execution failure without an assistant message', async () => {
  let onEvent;
  const messages = [];
  const api = {
    getSession: async () => ({ agent: 'build', model: { providerID: 'p', id: 'm' } }),
    messages: async () => messages,
    runCommand: async () => {
      messages.push({ id: 'msg_user', type: 'user', text: '/echo' }, { id: 'msg_idle', type: 'idle', outcome: 'failed' });
      queueMicrotask(() => onEvent({ type: 'session.execution.failed', data: { sessionID: 'ses_test', error: { type: 'provider.auth', message: 'Authentication failed' } } }));
    }, diff: async () => [],
  };
  const hub = { track: (_id, callback) => { onEvent = callback; return () => {}; }, onReconnect: () => () => {} };
  const result = await runTurn({ api, hub, request: { sessionID: 'ses_test', model: { providerID: 'p', modelID: 'm' }, command: { name: 'echo', text: '' }, timeoutMs: 1000 } });
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /Authentication failed/);
});

test('command fake accepts the V2 name/text body and completes after 204', async () => {
  const sessionID = 'ses_test';
  let resolveTurn;
  const turn = new Promise((resolve) => { resolveTurn = resolve; });
  const fake = { state: { sessions: { [sessionID]: {} }, messages: { [sessionID]: [] }, f3: { seq: 0 } },
    setStatus() {}, async emitTurn(id, result) { resolveTurn({ id, result }); } };
  const response = F3_SESSION_ROUTES['POST /api/session/:id/command'](fake,
    { params: { id: sessionID }, body: { name: 'echo', text: 'hi' } });
  assert.equal(response.status, 204);
  assert.equal(fake.state.messages[sessionID][0].text, '/echo hi');
  assert.deepEqual(await turn, { id: sessionID, result: { text: 'COMANDO echo ARGUMENTOS[hi]', error: undefined } });
});
