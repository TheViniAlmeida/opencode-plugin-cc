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
import { SEED } from '../fixtures/f3-fake.mjs';

// V2 paths: sessions carry location.directory, messages are flat (type/time/text) and compact answers 204.
const READ_PATHS = {
  session: ['id', 'title', 'location.directory', 'time.updated'], fork: ['id', 'title', 'fork.sessionID'], reverted: ['id', 'revert.messageID'],
  unreverted: ['id'], message: ['id', 'type', 'time.created', 'text'], diff: ['file', 'status', 'additions', 'deletions', 'patch'],
  command: ['name', 'description'], compacted: [''],
};
const ENDPOINTS = Object.keys(READ_PATHS);
async function capture(api, sid, model) {
  const messages = await api.messages(sid);
  const lastId = messages.filter((m) => m.type !== 'idle').at(-1).id;
  const fork = await api.fork(sid, { before: lastId }); const forkMsgs = await api.messages(fork.id);
  const forkUser = forkMsgs.find((m) => m.type === 'user');
  // Same sequence as `opc session revert/unrevert` (stage only: commit would drop the messages for good);
  // the session is read back so the shape does not depend on each action's body.
  await api.revertStage(fork.id, { messageID: forkUser.id });
  const reverted = await api.getSession(fork.id);
  await api.revertClear(fork.id);
  const unreverted = await api.getSession(fork.id);
  await api.setModel(fork.id, { providerID: model.providerID, id: model.modelID });
  const compacted = await api.compact(fork.id, { timeoutMs: 600000 });
  const [session, diff, commands] = await Promise.all([api.getSession(sid), api.diff(sid), api.commands()]);
  return { session, fork, reverted, unreverted, compacted, message: messages.find((m) => m.type === 'user'), diff: diff[0] ?? null, command: commands[0] ?? null };
}

test('F3 contract: OpenCode real vs fake para fork/revert/unrevert/compact/diff/command', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
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
  const fakeShapes = await capture(createApi(createClient({ baseUrl: fake.url, password: fakePassword, directory: '/fake' })), SEED.session, model);
  const result = compareShapes(real, fakeShapes, READ_PATHS);
  assertEndpointCoverage(result, ENDPOINTS);
  note('F3 contract — endpoints comparados e N/A', { ...result, endpoints: ENDPOINTS }, dataDir);
  assert.deepEqual(result.divergences, [], 'registre as divergências e atualize tests/fixtures/f3-fake.mjs');
});
