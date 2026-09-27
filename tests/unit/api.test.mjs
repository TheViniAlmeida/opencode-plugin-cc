import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { connectApi, createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { makeWorkspace, testEnv } from '../helpers.mjs';

function recordingClient() {
  const calls = [];
  return { calls, get: async (path, opts) => { calls.push({ method: 'GET', path, opts }); return { path }; } };
}

test('read methods map to the v1 routes and retry on ServerDown', async () => {
  const client = recordingClient();
  const api = createApi(client);
  await api.health(); await api.getConfig(); await api.providers(); await api.agents(); await api.commands(); await api.skills();
  await api.listSessions(); await api.getSession('ses_1'); await api.sessionStatus(); await api.messages('ses_1', { limit: 5 });
  await api.children('ses_1'); await api.diff('ses_1'); await api.todo('ses_1'); await api.listPermissions(); await api.listQuestions();
  assert.deepEqual(client.calls.map((c) => c.path), [
    '/global/health', '/config', '/provider', '/agent', '/command', '/skill', '/session', '/session/ses_1', '/session/status',
    '/session/ses_1/message', '/session/ses_1/children', '/session/ses_1/diff', '/session/ses_1/todo', '/permission', '/question',
  ]);
  assert.ok(client.calls.every((c) => c.opts.retryOnServerDown === true));
  assert.deepEqual(client.calls[9].opts.query, { limit: 5 });
  assert.equal(client.calls[7].opts.query, undefined);
});

test('session ids are URL-encoded', async () => {
  const client = recordingClient();
  await createApi(client).getSession('../x y');
  assert.equal(client.calls[0].path, '/session/..%2Fx%20y');
});

test('connectApi starts/reuses the workspace server and returns { api, server, client }', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t); // the F0 per-test cleanup stops this env × workspace server before removing the dirs
  const ctx = await createContext({ argv: [], env, cwd: ws, createDataDir: true });
  const { api, server, client } = await connectApi(ctx);
  assert.equal(client.baseUrl, server.url);
  assert.equal(client.directory, ctx.workspaceRoot);
  assert.equal((await api.health()).healthy, true);
});
