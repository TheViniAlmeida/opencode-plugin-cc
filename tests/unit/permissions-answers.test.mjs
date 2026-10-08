import test from 'node:test';
import assert from 'node:assert/strict';
import { list, parseAnswers, run } from '../../plugins/opc/scripts/commands/permissions.mjs';
import { createJob, listJobs, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
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
    pendingRequest: [{ id: 'per_local', type: 'permission', permission: 'shell', patterns: ['echo ok'], sessionID: 'ses_local' }],
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
    { id: 'per_saved_123456789', type: 'permission', permission: 'shell', patterns: ['echo saved'], sessionID: 'ses_saved123456789' },
  ] });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {});
  assert.match(ctx.output, /per_saved_123456789/);
  assert.match(ctx.output, /servidor não está em execução/);
});

test('reply masks the supplied id and keeps follow-up line when bridge clears the job', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const pendingId = 'per_562c642c123456789';
  const sessionID = 'ses_session123456789';
  const job = await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', sessionID, pendingRequest: [
    { id: pendingId, type: 'permission', permission: 'shell', patterns: ['echo ok'], sessionID },
  ] });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = {
    async listPermissions(id) { assert.equal(id, sessionID); return [{ id: pendingId, permission: 'shell', sessionID }]; },
    async replyPermission(id, requestID, body) { assert.equal(id, sessionID); assert.equal(requestID, pendingId); assert.equal(body.reply, 'reject'); await updateJob(stateDir, job.id, { pendingRequest: null, status: 'running' }); },
  };
  await run(ctx, ['reply', pendingId, 'reject'], { getApi: () => api });
  assert.match(ctx.output, /Resposta reject enviada para per_562c642c…/);
  assert.ok(!ctx.output.includes(pendingId));
  assert.match(ctx.output, new RegExp(`/opc:status ${job.id} --wait`));
});

test('permissions reply masks the supplied id and reports sibling identifiers', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const ids = ['per_562c642c123456789', 'per_89ab0345123456789'];
  const sessionID = 'ses_session123456789';
  await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', sessionID, pendingRequest: ids.map((id) => ({ id, type: 'permission', permission: 'shell', patterns: ['echo ok'], sessionID })) });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = { async listPermissions() { return ids.map((id) => ({ id, permission: 'shell', sessionID })); }, async replyPermission() {} };
  await run(ctx, ['reply', ids[0], 'reject'], { getApi: () => api });
  assert.ok(!ctx.output.includes(ids[0]), ctx.output);
  assert.ok(ctx.output.includes(ids[1]), ctx.output);
});

test('permissions answer uses the V2 form session and string[][] answers', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const sessionID = 'ses_session123456789';
  const formID = 'frm_form123456789';
  await createJob(stateDir, { kind: 'task', title: 'test', workspaceRoot: '/ws', status: 'waiting_permission', sessionID, pendingRequest: [{ id: formID, type: 'question', sessionID, questions }] });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = {
    async listQuestions(id) { assert.equal(id, sessionID); return [{ id: formID, sessionID, questions }]; },
    async replyQuestion(id, request, answers) { assert.equal(id, sessionID); assert.equal(request.id, formID); assert.deepEqual(answers, [['Postgres'], ['A', 'C'], ['my-name']]); },
  };
  assert.equal(await run(ctx, ['answer', formID, 'postgres', 'A|C', 'my-name'], { getApi: () => api }), 0);
  assert.match(ctx.output, /Resposta enviada/);
});

test('permissions list with no jobs and no server reports an empty list', async () => {
  const ctx = { stateDir: '/missing-state', out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = JSON.stringify(value); } };
  await list(ctx, {}, () => null);
  assert.match(ctx.output, /Nenhuma solicitação pendente/);
});

test('permissions list discovers pending requests in every OPC workspace session', async () => {
  const ctx = { stateDir: '/missing-state', out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = value; } };
  const seen = [];
  const api = {
    async listSessions() { return [{ id: 'ses_first', title: 'OPC: first' }, { id: 'ses_second', title: 'OPC: second' }, { id: 'ses_other', title: 'unrelated' }]; },
    async listPermissions(id) { seen.push(id); return [{ id: `per_${id}`, sessionID: id, permission: 'shell', patterns: ['ls'] }]; },
    async listQuestions() { return []; },
  };
  await list(ctx, { json: true }, () => api);
  assert.deepEqual(seen, ['ses_first', 'ses_second']);
  assert.deepEqual(ctx.output.requests.map((request) => request.id), ['per_ses_first', 'per_ses_second']);
});

test('permissions list and reply discover a child session without an OPC title or local job', async () => {
  const ctx = { stateDir: '/missing-state', config: { policy: { approver: 'claude' } }, out: (value) => { ctx.output = value; }, json: (value) => { ctx.output = value; } };
  const calls = [];
  const api = {
    async listSessions() { return [{ id: 'ses_parent', title: 'OPC: task' }, { id: 'ses_child', title: 'general', parentID: 'ses_parent' }, { id: 'ses_other', title: 'unrelated' }]; },
    async listPermissions(id) { calls.push(id); return id === 'ses_child' ? [{ id: 'per_child', sessionID: id, permission: 'shell', patterns: ['ls'] }] : []; },
    async listQuestions() { return []; },
    async replyPermission(id, requestID, body) { assert.deepEqual([id, requestID, body.reply], ['ses_child', 'per_child', 'once']); },
  };
  await list(ctx, { json: true }, () => api);
  assert.deepEqual(calls, ['ses_parent', 'ses_child']);
  assert.deepEqual(ctx.output.requests.map((request) => request.id), ['per_child']);
  await run(ctx, ['reply', 'per_child', 'once'], { getApi: () => api });
});

test('reply clears a grouped request on the member and on its group, and points to the member', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-permissions-'));
  const pendingId = 'per_562c642c123456789';
  const sessionID = 'ses_session123456789';
  const request = { id: pendingId, type: 'permission', permission: 'shell', patterns: ['echo ok'], sessionID };
  // Member first, group second: the group is the newest job, so a first-match lookup would only see the group.
  const member = await createJob(stateDir, { kind: 'task', title: 'member', workspaceRoot: '/ws', status: 'waiting_permission', role: 'worker:1', sessionID, pendingRequest: [request] });
  const group = await createJob(stateDir, { kind: 'orchestrate', title: 'group', workspaceRoot: '/ws', status: 'waiting_permission', role: 'group', pendingRequest: [request] });
  await updateJob(stateDir, member.id, { groupId: group.id });
  const ctx = { stateDir, out: (value) => { ctx.output = value; }, json() {} };
  const api = { async listPermissions() { return [{ id: pendingId, permission: 'shell', sessionID }]; }, async replyPermission() {} };
  await run(ctx, ['reply', pendingId, 'reject'], { getApi: () => api });
  const jobs = listJobs(stateDir, { all: true });
  for (const id of [member.id, group.id]) assert.deepEqual(jobs.find((j) => j.id === id).pendingRequest ?? [], [], id);
  assert.match(ctx.output, new RegExp(`/opc:status ${member.id} --wait`));
});
