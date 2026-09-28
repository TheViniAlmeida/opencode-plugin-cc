import test from 'node:test';
import assert from 'node:assert/strict';
import { list, parseAnswers, run } from '../../plugins/opc/scripts/commands/permissions.mjs';
import { createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

const questions = [
  { question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }], custom: false },
  { question: 'Features?', header: 'Features', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }], multiple: true, custom: false },
  { question: 'Name?', header: 'Name', options: [{ label: 'default', description: '' }] },
];

test('parseAnswers builds string[][] in question order; case-insensitive labels; custom text', () => {
  assert.deepEqual(parseAnswers(questions, ['postgres', 'A|c', 'my-name']), [['Postgres'], ['A', 'C'], ['my-name']]);
  assert.deepEqual(parseAnswers(questions, ['SQLite', 'B', 'Default']), [['SQLite'], ['B'], ['default']]);
});

test('parseAnswers rejects wrong counts, empty and non-option answers when custom is false', () => {
  assert.throws(() => parseAnswers(questions, ['Postgres']), (e) => e.code === 'ANSWER_COUNT' && /eram esperadas 3 resposta/.test(e.message) && /1\. \[DB\]/.test(e.message));
  assert.throws(() => parseAnswers(questions, ['MySQL', 'A', 'x']), (e) => e.code === 'ANSWER_INVALID');
  assert.throws(() => parseAnswers(questions, ['Postgres', '|', 'x']), (e) => e.code === 'ANSWER_EMPTY');
});

test('permissions list falls back with recorded requests when the server is down or absent', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  let job = await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws' });
  job = await updateJob(stateDir, job.id, {
    status: 'waiting_permission',
    pendingRequest: [{ id: 'per_local', type: 'permission', permission: 'bash', patterns: ['echo ok'], sessionID: 'ses_local' }],
  });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {}, () => ({
    listPermissions: async () => { throw new ConnectionError('SERVER_DOWN', 'offline'); },
    listQuestions: async () => [],
  }));
  assert.match(ctx.output, /per_local/);
  assert.match(ctx.output, /servidor não está em execução/);
  ctx.output = '';
  await list(ctx, {}, () => null);
  assert.match(ctx.output, /per_local/);
  assert.match(ctx.output, /servidor não está em execução/);
});

test('permissions list with no registered server still reports recorded requests', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', pendingRequest: [
    { id: 'per_saved_123456789', type: 'permission', permission: 'bash', patterns: ['echo saved'], sessionID: 'ses_saved123456789' },
  ] });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {});
  assert.match(ctx.output, /per_saved_123456789/);
  assert.match(ctx.output, /servidor não está em execução/);
});

test('reply keeps full ids and follow-up line when bridge clears the job during the API reply', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const pendingId = 'per_562c642c123456789';
  const sessionID = 'ses_session123456789';
  const job = await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', sessionID, pendingRequest: [
    { id: pendingId, type: 'permission', permission: 'bash', patterns: ['echo ok'], sessionID },
  ] });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = {
    async listPermissions() { return [{ id: pendingId, permission: 'bash', sessionID }]; },
    async replyPermission() { await updateJob(stateDir, job.id, { pendingRequest: null, status: 'running' }); },
  };
  await run(ctx, ['reply', pendingId, 'reject'], { getApi: () => api });
  assert.match(ctx.output, new RegExp(`Resposta reject enviada para ${pendingId}`));
  assert.match(ctx.output, new RegExp(`/opc:status ${job.id} --wait`));
});

test('permissions reply prints full sibling request identifiers', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const ids = ['per_562c642c123456789', 'per_89ab0345123456789'];
  const sessionID = 'ses_session123456789';
  await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', sessionID, pendingRequest: ids.map((id) => ({ id, type: 'permission', permission: 'bash', patterns: ['echo ok'], sessionID })) });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = { async listPermissions() { return ids.map((id) => ({ id, permission: 'bash', sessionID })); }, async replyPermission() {} };
  await run(ctx, ['reply', ids[0], 'reject'], { getApi: () => api });
  assert.ok(ids.every((id) => ctx.output.includes(id)), ctx.output);
});

test('permissions list with no jobs and no server reports an empty list', async () => {
  const ctx = { stateDir: '/missing-state', out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {}, () => null);
  assert.match(ctx.output, /Nenhuma solicitação pendente/);
});
