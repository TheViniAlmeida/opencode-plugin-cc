import test from 'node:test';
import assert from 'node:assert/strict';
import { waitCommandResult } from '../../plugins/opc/scripts/commands/command.mjs';
import { F3_SESSION_ROUTES } from '../fixtures/f3-fake.mjs';

test('204 command waits for a new idle and returns assistant text', async () => {
  const initial = [{ id: 'msg_old', type: 'idle', outcome: 'succeeded' }];
  let messages = initial;
  let reads = 0;
  const api = { async messages() {
    reads += 1;
    if (reads === 2) messages = [...initial, { id: 'msg_user', type: 'user', text: '/echo' }];
    if (reads === 3) messages = [...messages, { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: 'ready' }] }, { id: 'msg_idle', type: 'idle', outcome: 'succeeded' }];
    return messages;
  } };
  const baseline = new Set((await api.messages('ses_test')).map((message) => message.id));
  const result = await waitCommandResult(api, 'ses_test', baseline, { timeoutMs: 1000, pollMs: 1 });
  assert.equal(reads, 3);
  assert.equal(result.finalText, 'ready');
  assert.equal(result.error, null);
});

test('204 command reports a later execution failure', async () => {
  const api = { async messages() { return [
    { id: 'msg_user', type: 'user', text: '/echo' },
    { id: 'msg_idle', type: 'idle', outcome: 'failed' },
  ]; } };
  const result = await waitCommandResult(api, 'ses_test', new Set(), { timeoutMs: 1000, pollMs: 1,
    getExecutionError: () => ({ type: 'provider.auth', message: 'Authentication failed' }) });
  assert.equal(result.error.message, 'Authentication failed');
});

test('204 command never treats an old idle or empty response as success', async () => {
  const api = { async messages() { return [{ id: 'msg_old', type: 'idle', outcome: 'succeeded' }]; } };
  await assert.rejects(waitCommandResult(api, 'ses_test', new Set(['msg_old']), { timeoutMs: 10, pollMs: 1 }),
    (error) => error.code === 'TIMEOUT');
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
