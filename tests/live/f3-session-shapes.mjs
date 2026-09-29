import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, LIVE_MODEL, liveWorkspace, opc, record, note, compareShapes, assertEndpointCoverage } from './_f3-lib.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';

const READ_PATHS = {
  session: ['id', 'title', 'directory', 'time.updated'], fork: ['id', 'title'], reverted: ['id', 'revert.messageID', 'revert.diff'],
  unreverted: ['id'], message: ['info.id', 'info.role', 'parts'], diff: ['file', 'status', 'additions', 'deletions', 'patch'],
  todo: ['content', 'status', 'priority'], command: ['name', 'template', 'hints'], summarized: [''],
};
const ENDPOINTS = Object.keys(READ_PATHS);
async function capture(api, sid, model) {
  const messages = await api.messages(sid); const lastId = messages.at(-1).info.id;
  const fork = await api.fork(sid, { messageID: lastId }); const forkMsgs = await api.messages(fork.id);
  const forkUser = forkMsgs.find((m) => m.info.role === 'user');
  const reverted = await api.revert(fork.id, { messageID: forkUser.info.id });
  const unreverted = await api.unrevert(fork.id);
  const summarized = await api.summarize(fork.id, { providerID: model.providerID, modelID: model.modelID, timeoutMs: 600000 });
  const [session, diff, todo, commands] = await Promise.all([api.getSession(sid), api.diff(sid), api.todo(sid), api.commands()]);
  return { session, fork, reverted, unreverted, summarized, message: messages[0], diff: diff[0] ?? null, todo: todo[0] ?? null, command: commands[0] ?? null };
}

test('F3 contract: OpenCode real vs fake para fork/revert/unrevert/summarize/diff/todo/command', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { root, ws, env, dataDir, stateDir } = liveWorkspace(t);
  const created = await opc(['session', 'new', '--title', 'contract', '--model', MODELS.deepseek, '--write', '--json'], { env, cwd: ws });
  assert.equal(created.code, 0, created.stderr);
  const sid = JSON.parse(created.stdout).session.id;
  const turn = await opc(['task', '--resume', sid, '--write', '--model', MODELS.deepseek, 'Append a line CONTRACT to notes.txt. Do not run shell commands.'], { env, cwd: ws });
  record('contract: turno de preparo', turn, dataDir);
  assert.equal(turn.code, 0, turn.stderr);
  const server = JSON.parse(readFileSync(join(stateDir(), 'server.json'), 'utf8'));
  registerSecret(server.password);
  const [providerID, ...modelParts] = LIVE_MODEL.split('/');
  const model = { providerID, modelID: modelParts.join('/') };
  const real = await capture(createApi(createClient({ baseUrl: server.url, password: server.password, directory: resolveWorkspaceRoot(ws) })), sid, model);
  const fakePassword = 'contract-fake-password-000';
  const fake = await startFake({ port: await pickFreePort(), password: fakePassword, scenario: 'f3-sessions', stateFile: join(root, 'fake-state.json') });
  t.after(() => fake.close());
  const fakeShapes = await capture(createApi(createClient({ baseUrl: fake.url, password: fakePassword, directory: '/fake' })), 'ses_seed', model);
  const result = compareShapes(real, fakeShapes, READ_PATHS);
  assertEndpointCoverage(result, ENDPOINTS);
  note('F3 contract — endpoints comparados e N/A', { ...result, endpoints: ENDPOINTS }, dataDir);
  assert.deepEqual(result.divergences, [], 'registre as divergências e atualize tests/fixtures/f3-fake.mjs');
});
