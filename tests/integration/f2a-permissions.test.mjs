import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, jobIdFrom, jobIn, opc, readFakeState, setupF2a, waitFor } from '../helpers.mjs';

const permissionIdFrom = (text) => /reply (per_[0-9A-Za-z]+) once/.exec(text)?.[1];
const questionIdFrom = (text) => /answer (que_[0-9A-Za-z]+)/.exec(text)?.[1];

test('permission-ask foreground: exit 3 with ready lines; approver user needs --confirmed-by-user; then completes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const r = await opc(ctx, ['task', '--write', 'clean the build']);
  assert.equal(r.code, 3, r.stderr);
  const id = jobIdFrom(r.stderr);
  const perId = permissionIdFrom(r.stdout);
  assert.ok(perId, r.stdout);
  assert.match(r.stdout, /Ferramenta: bash/);
  assert.match(r.stdout, /rm -rf build/);
  assert.match(r.stdout, /Exige o usuário: sim/);
  assert.match(r.stdout, new RegExp(`/opc:permissions reply ${perId} reject`));
  assert.match(r.stdout, new RegExp(`/opc:status ${id} --wait`));
  const job = jobIn(ctx.env, ctx.cwd, id);
  assert.equal(job.status, 'waiting_permission');
  assert.equal(job.pendingRequest[0].id, perId);
  const listed = await opc(ctx, ['permissions', 'list']);
  assert.match(listed.stdout, new RegExp(`${perId} \\| permission \\| bash: rm -rf build`));
  const refused = await opc(ctx, ['permissions', 'reply', perId, 'once']);
  assert.equal(refused.code, 4);
  assert.match(refused.stdout + refused.stderr, /NEEDS_USER/);
  const ok = await opc(ctx, ['permissions', 'reply', perId, 'once', '--confirmed-by-user']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`/opc:status ${id} --wait`));
  const waited = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waited.code, 0, waited.stdout);
  const result = await opc(ctx, ['result', id]);
  assert.match(result.stdout, /approved \(once\) and ran: rm -rf build/);
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => x.reply), ['once']);
});

test('permission-ask background: waits, reply reject with message, completes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'clean'])).stdout);
  const waiting = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(waiting.code, 3, waiting.stdout);
  const perId = permissionIdFrom(waiting.stdout);
  const reply = await opc(ctx, ['permissions', 'reply', perId, 'reject', 'not', 'today']);
  assert.equal(reply.code, 0, reply.stderr);
  assert.match(reply.stdout, new RegExp(`/opc:status ${bg.jobId} --wait`));
  const done = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /rejected: not today/);
});

test('permission timeout in background → reject "opc: no approver available"', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask', config: { policy: { ...F2A_POLICY, permissionTimeoutSec: 1 } } });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'clean'])).stdout);
  const done = await opc(ctx, ['status', bg.jobId, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.ok([0, 3].includes(done.code));
  await waitFor(() => jobIn(ctx.env, ctx.cwd, bg.jobId)?.status === 'completed', { timeoutMs: 20000, intervalMs: 100, message: 'completion after timeout' });
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => [x.reply, x.message]), [['reject', 'opc: nenhum aprovador disponível']]);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /rejected: opc: nenhum aprovador disponível/);
});

test('child-permission-ask reaches the job (child session marked)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'child-permission-ask' });
  const r = await opc(ctx, ['task', '--write', 'use a subagent']);
  assert.equal(r.code, 3, r.stderr);
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  const [pending] = job.pendingRequest;
  assert.notEqual(pending.sessionID, job.sessionID);
  assert.match(r.stdout, /\(sessão filha\)/);
  assert.equal((await opc(ctx, ['permissions', 'reply', pending.id, 'reject'])).code, 0);
  const done = await opc(ctx, ['status', job.id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.ok(jobIn(ctx.env, ctx.cwd, job.id).childSessionIDs.includes(pending.sessionID));
});

test('reject-siblings: rejecting one request clears both from the job', async (t) => {
  const ctx = setupF2a(t, { scenario: 'reject-siblings' });
  const r = await opc(ctx, ['task', '--write', 'two requests']);
  assert.equal(r.code, 3);
  const id = jobIdFrom(r.stderr);
  const job = await waitFor(() => {
    const current = jobIn(ctx.env, ctx.cwd, id);
    return current.pendingRequest?.length === 2 ? current : null;
  }, { timeoutMs: 20000, intervalMs: 100, message: 'two pending requests' });
  const reply = await opc(ctx, ['permissions', 'reply', job.pendingRequest[0].id, 'reject']);
  assert.equal(reply.code, 0, reply.stderr);
  assert.match(reply.stdout, new RegExp(`O OpenCode também recusou as outras solicitações pendentes desta sessão: ${job.pendingRequest[1].id}`));
  const done = await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200']);
  assert.equal(done.code, 0);
  assert.equal(jobIn(ctx.env, ctx.cwd, id).pendingRequest, null);
  assert.match((await opc(ctx, ['result', id])).stdout, /outcomes: reject,reject/);
  assert.equal(readFakeState(ctx.env).permissionReplies.length, 2);
});

test('question-ask: answer with several questions (string[][]); multiple and custom', async (t) => {
  const ctx = setupF2a(t, { scenario: 'question-ask' });
  const r = await opc(ctx, ['task', '--write', 'ask me']);
  assert.equal(r.code, 3, r.stderr);
  const queId = questionIdFrom(r.stdout);
  assert.match(r.stdout, /Opções: Postgres \| SQLite/);
  const bad = await opc(ctx, ['permissions', '--args-stdin'], { stdin: `answer ${queId} MySQL A svc` });
  assert.equal(bad.code, 2);
  const ok = await opc(ctx, ['permissions', '--args-stdin'], { stdin: `answer ${queId} postgres "A|C" "my service"` });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`/opc:status ${jobIdFrom(r.stderr)} --wait`));
  assert.deepEqual(readFakeState(ctx.env).questionReplies[0].answers, [['Postgres'], ['A', 'C'], ['my service']]);
  const id = jobIdFrom(r.stderr);
  assert.equal((await opc(ctx, ['status', id, '--wait', '--timeout-ms', '30000', '--poll-interval-ms', '200'])).code, 0);
  assert.match((await opc(ctx, ['result', id])).stdout, /answers: \[\["Postgres"\],\["A","C"\],\["my service"\]\]/);
});

test('question timeout → question reject', async (t) => {
  const ctx = setupF2a(t, { scenario: 'question-ask', config: { policy: { ...F2A_POLICY, permissionTimeoutSec: 1 } } });
  const bg = JSON.parse((await opc(ctx, ['task', '--write', '--background', '--json', 'ask me'])).stdout);
  await waitFor(() => jobIn(ctx.env, ctx.cwd, bg.jobId)?.status === 'completed', { timeoutMs: 20000, intervalMs: 100, message: 'completion after question timeout' });
  assert.equal(readFakeState(ctx.env).questionRejects.length, 1);
  assert.match((await opc(ctx, ['result', bg.jobId])).stdout, /question rejected/);
});

test('reply always is refused (exit 2) without contacting the server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['permissions', 'reply', 'per_anything', 'always']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /nunca é enviado/);
  assert.equal(readFakeState(ctx.env).requests.length, 0);
});

test('approver claude: destructive needs --confirmed-by-user (exit 4); benign does not', async (t) => {
  const policy = { ...F2A_POLICY, approver: 'claude' };
  const destructive = setupF2a(t, { scenario: 'permission-ask', config: { policy } });
  const r1 = await opc(destructive, ['task', '--write', 'clean']);
  assert.equal(r1.code, 3);
  const refused = await opc(destructive, ['permissions', 'reply', permissionIdFrom(r1.stdout), 'once']);
  assert.equal(refused.code, 4);
  const benign = setupF2a(t, { scenario: 'permission-ask', config: { policy }, extraEnv: { FAKE_PERMISSION_COMMAND: 'ls -la' } });
  const r2 = await opc(benign, ['task', '--write', 'list']);
  assert.equal(r2.code, 3);
  const accepted = await opc(benign, ['permissions', 'reply', permissionIdFrom(r2.stdout), 'once']);
  assert.equal(accepted.code, 0, accepted.stderr);
});

test('read-only profile: any permission request is rejected immediately by the bridge', async (t) => {
  const ctx = setupF2a(t, { scenario: 'permission-ask' });
  const r = await opc(ctx, ['task', 'read only']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rejected: opc: read-only profile; request rejected/);
  assert.deepEqual(readFakeState(ctx.env).permissionReplies.map((x) => x.reply), ['reject']);
});
