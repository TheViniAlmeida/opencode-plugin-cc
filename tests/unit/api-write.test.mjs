import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

function recordingClient() {
  const calls = [];
  const record = (method) => async (path, body) => { calls.push([method, path, body]); return method === 'POST' && path.endsWith('/prompt_async') ? null : { ok: true }; };
  return { calls, get: record('GET'), post: record('POST'), patch: record('PATCH') };
}

test('write methods hit the OpenAPI 1.18.32 routes with the right bodies', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await api.createSession({ title: 'OPC: task: x', permission: [] });
  await api.patchSession('ses_1', { permission: [{ permission: '*', pattern: '*', action: 'deny' }] });
  assert.equal(await api.promptAsync('ses_1', { messageID: 'msg_1', parts: [] }), null);
  await api.abort('ses_1');
  await api.replyPermission('per_1', { reply: 'reject', message: 'no' });
  await api.replyPermission('per_2', { reply: 'once' });
  await api.replyQuestion('que_1', [['A'], ['B', 'C']]);
  await api.rejectQuestion('que_2');
  assert.deepEqual(client.calls, [
    ['POST', '/session', { title: 'OPC: task: x', permission: [] }],
    ['PATCH', '/session/ses_1', { permission: [{ permission: '*', pattern: '*', action: 'deny' }] }],
    ['POST', '/session/ses_1/prompt_async', { messageID: 'msg_1', parts: [] }],
    ['POST', '/session/ses_1/abort', undefined],
    ['POST', '/permission/per_1/reply', { reply: 'reject', message: 'no' }],
    ['POST', '/permission/per_2/reply', { reply: 'once' }],
    ['POST', '/question/que_1/reply', { answers: [['A'], ['B', 'C']] }],
    ['POST', '/question/que_2/reject', undefined],
  ]);
});

test('replyPermission never sends "always"; bad answers and ids are refused', () => {
  const api = createApi(recordingClient());
  assert.throws(() => api.replyPermission('per_1', { reply: 'always' }), (e) => e.code === 'INVALID_REPLY');
  assert.throws(() => api.replyQuestion('que_1', ['A']), (e) => e.exitCode === 2);
  assert.throws(() => api.abort(''), (e) => e.exitCode === 2);
  const client = recordingClient();
  createApi(client).abort('ses/../x');
  assert.equal(client.calls[0][1], '/session/ses%2F..%2Fx/abort');
});
