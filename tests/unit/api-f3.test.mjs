import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, assertId } from '../../plugins/opc/scripts/lib/api.mjs';

function recorder() {
  const calls = [];
  const client = {
    get: async (path, opts) => { calls.push({ method: 'GET', path, opts }); return null; },
    post: async (path, body, opts) => { calls.push({ method: 'POST', path, body, opts }); return null; },
    delete: async (path, opts) => { calls.push({ method: 'DELETE', path, opts }); return null; },
  };
  return { client, calls };
}

test('assertId accepts IDs and rejects path tricks', () => {
  assert.equal(assertId('ses', 'ses_2b1XyZ-9'), 'ses_2b1XyZ-9');
  for (const bad of ['ses_x/../../global/dispose', 'msg_1', '', undefined, 'ses x', 'ses_$(id)', 'ses_%2e%2e']) {
    assert.throws(() => assertId('ses', bad), { code: 'INVALID_ID' });
  }
});

test('fork, revert, compact and command use V2 request shapes', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  await api.fork('ses_a', { before: 'msg_b' });
  await api.fork('ses_a');
  await api.revertStage('ses_a', { messageID: 'msg_b' });
  await api.revertCommit('ses_a');
  await api.revertClear('ses_a');
  await api.compact('ses_a');
  await api.runCommand('ses_a', { name: 'echo', text: 'x y' });
  await api.diff('ses_a');
  assert.deepEqual(calls.map(({ method, path, body }) => [method, path, body]), [
    ['POST', '/api/session/ses_a/fork', { before: 'msg_b' }],
    ['POST', '/api/session/ses_a/fork', {}],
    ['POST', '/api/session/ses_a/revert/stage', { messageID: 'msg_b' }],
    ['POST', '/api/session/ses_a/revert/commit', undefined],
    ['DELETE', '/api/session/ses_a/revert', undefined],
    ['POST', '/api/session/ses_a/compact', {}],
    ['POST', '/api/session/ses_a/command', { name: 'echo', text: 'x y' }],
    ['GET', '/api/session/ses_a/diff', undefined],
  ]);
});

test('invalid optional IDs are rejected without sending a request', async () => {
  const { client, calls } = recorder();
  const api = createApi(client);
  assert.throws(() => api.fork('ses_a', { before: '' }), { code: 'INVALID_ID' });
  assert.throws(() => api.revertStage('ses_a', {}), { code: 'MISSING_MESSAGE_ID' });
  assert.throws(() => api.revertStage('ses_a', { messageID: '' }), { code: 'INVALID_ID' });
  assert.throws(() => api.runCommand('ses_a', {}), { code: 'MISSING_COMMAND' });
  assert.equal(calls.length, 0);
});
