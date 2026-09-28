import test from 'node:test';
import assert from 'node:assert/strict';
import { list, parseAnswers } from '../../plugins/opc/scripts/commands/permissions.mjs';
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

test('permissions list falls back only on SERVER_DOWN and labels the local fallback in Portuguese', async (t) => {
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
  await assert.rejects(list(ctx, {}, () => ({
    listPermissions: async () => { throw new ConnectionError('AUTH_FAILED', 'unauthorized'); },
    listQuestions: async () => [],
  })), (error) => error.code === 'AUTH_FAILED' && error.exitCode === 5);
});

test('permissions list with no registered server does not issue requests and reports an empty list', async () => {
  const ctx = { stateDir: '/missing-state', out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {}, () => null);
  assert.match(ctx.output, /Nenhuma solicitação pendente/);
});
