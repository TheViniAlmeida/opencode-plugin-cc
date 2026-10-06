import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

function recordingClient() {
  const calls = [];
  const record = (method) => async (path, body) => { calls.push([method, path, body]); return method === 'POST' && path.endsWith('/interrupt') ? { interrupted: true } : null; };
  return { calls, get: record('GET'), post: record('POST'), patch: record('PATCH'), delete: record('DELETE') };
}

test('write methods use V2 routes and bodies', async () => {
  const client = recordingClient();
  const api = createApi(client);
  const permissions = [{ action: '*', resource: '*', effect: 'deny' }];
  const model = { providerID: 'p', id: 'm' };
  await api.createSession({ title: 'OPC: task: x', permissions, model });
  await api.setPermissions('ses_1', permissions);
  await api.setModel('ses_1', model);
  await api.setAgent('ses_1', 'build');
  await api.prompt('ses_1', { id: 'msg_1', text: 'hello', agents: [] });
  assert.equal(await api.interrupt('ses_1'), true);
  await api.replyPermission('ses_1', 'per_1', { reply: 'reject', message: 'no' });
  await api.replyPermission('ses_1', 'per_2', { reply: 'once' });
  const question = { id: 'frm_1', questions: [{ key: 'q0', options: [{ label: 'Red', value: 'red' }], multiple: false }] };
  await api.replyQuestion('ses_1', question, [['Red']]);
  await api.rejectQuestion('ses_1', 'frm_2');
  assert.deepEqual(client.calls, [
    ['POST', '/api/session', { title: 'OPC: task: x', permissions, model }],
    ['PATCH', '/api/session/ses_1', { permissions }],
    ['POST', '/api/session/ses_1/model', { model }],
    ['POST', '/api/session/ses_1/agent', { agent: 'build' }],
    ['POST', '/api/session/ses_1/prompt', { id: 'msg_1', text: 'hello', agents: [] }],
    ['POST', '/api/session/ses_1/interrupt', undefined],
    ['POST', '/api/session/ses_1/permission/per_1/reply', { decision: 'reject', message: 'no' }],
    ['POST', '/api/session/ses_1/permission/per_2/reply', { decision: 'once' }],
    ['POST', '/api/session/ses_1/form/frm_1/reply', { answer: { q0: 'red' } }],
    ['DELETE', '/api/session/ses_1/form/frm_2', undefined],
  ]);
});

test('unsafe sessions and invalid replies are refused before HTTP', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await assert.rejects(api.createSession({ title: 'OPC: x' }), { code: 'UNSAFE_SESSION' });
  await assert.rejects(api.replyPermission('ses_1', 'per_1', { reply: 'always' }), { code: 'INVALID_REPLY' });
  await assert.rejects(api.replyQuestion('ses_1', { id: 'frm_1', questions: [] }, ['A']), { code: 'USAGE' });
  assert.throws(() => api.rejectQuestion('', 'frm_1'), { code: 'INVALID_ID' });
  assert.equal(client.calls.length, 0);
});
