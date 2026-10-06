import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

function recordingClient() {
  const calls = [];
  return { calls, get: async (path, opts) => { calls.push({ method: 'GET', path, opts }); return path.endsWith('/active') ? { ses_a: { type: 'running' } } : path.endsWith('/permission') || path.endsWith('/form') ? [] : { path }; } };
}

test('read methods map to V2 routes and retry on ServerDown', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await api.info(); await api.getConfigSources(); await api.providers(); await api.models(); await api.defaultModel();
  await api.agents(); await api.commands(); await api.skills();
  await api.listSessions({ parentID: 'ses_a', limit: 5 }); await api.getSession('ses_a');
  assert.deepEqual(await api.sessionStatus(), { ses_a: { type: 'busy' } });
  await api.messages('ses_a'); await api.message('ses_a', 'msg_b'); await api.children('ses_a');
  await api.diff('ses_a'); await api.listPermissions('ses_a'); await api.listQuestions('ses_a');
  assert.deepEqual(client.calls.map((call) => call.path), [
    '/api/info', '/api/config', '/api/provider', '/api/model', '/api/model/default', '/api/agent',
    '/api/command', '/api/skill', '/api/session', '/api/session/ses_a', '/api/session/active',
    '/api/session/ses_a/message', '/api/session/ses_a/message/msg_b', '/api/session',
    '/api/session/ses_a/diff', '/api/session/ses_a/permission', '/api/session/ses_a/form',
  ]);
  assert.ok(client.calls.every((call) => call.opts.retryOnServerDown === true));
  assert.deepEqual(client.calls[8].opts.query, { parentID: 'ses_a', limit: 5 });
  assert.deepEqual(client.calls[11].opts.query, { order: 'asc', limit: 200 });
  assert.deepEqual(client.calls[13].opts.query, { parentID: 'ses_a' });
});

test('session ids with path tricks are refused', async () => {
  const client = recordingClient();
  assert.throws(() => createApi(client).getSession('../x y'), { code: 'INVALID_ID' });
  assert.equal(client.calls.length, 0);
});
