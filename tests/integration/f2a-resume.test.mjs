import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, jobIdFrom, jobIn, opc, requestsTo, setupF2a, waitFor } from '../helpers.mjs';

test('--resume <job> mantém a sessão; sem prompt → continue.md', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const first = await opc(ctx, ['task', 'first turn']);
  assert.equal(first.code, 0, first.stderr);
  const a = jobIn(ctx.env, ctx.cwd, jobIdFrom(first.stderr));
  const second = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--resume ${a.id} second turn` });
  assert.equal(second.code, 0, second.stderr);
  const b = jobIn(ctx.env, ctx.cwd, jobIdFrom(second.stderr));
  assert.equal(b.sessionID, a.sessionID);
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 1);
  assert.equal(requestsTo(ctx.env, 'POST', `/api/session/${a.sessionID}/prompt`).length, 2);
  const third = await opc(ctx, ['task', '--resume', a.id]);
  assert.equal(third.code, 0, third.stderr);
  const prompts = requestsTo(ctx.env, 'POST', `/api/session/${a.sessionID}/prompt`);
  assert.equal(prompts.at(-1).body.text, readFileSync(join(PLUGIN_ROOT, 'prompts', 'continue.md'), 'utf8'));
  assert.equal(jobIn(ctx.env, ctx.cwd, jobIdFrom(third.stderr)).summary, 'continue');
});

test('--resume sem id retoma o último job concluído do mesmo tipo nesta sessão Claude', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const asked = await opc(ctx, ['ask', 'question one']);
  const askJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(asked.stderr));
  const tasked = await opc(ctx, ['task', 'task one']);
  const taskJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(tasked.stderr));
  const resumedAsk = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: '--resume and a follow-up' });
  assert.equal(resumedAsk.code, 0, resumedAsk.stderr);
  assert.equal(jobIn(ctx.env, ctx.cwd, jobIdFrom(resumedAsk.stderr)).sessionID, askJob.sessionID);
  assert.notEqual(askJob.sessionID, taskJob.sessionID);
  const noSession = await opc(ctx, ['task', '--resume', 'x'], { env: { OPC_COMPANION_SESSION_ID: '' } });
  assert.equal(noSession.code, 2);
  assert.match(noSession.stdout + noSession.stderr, /RESUME_NEEDS_ID/);
});

test('task-resume-candidate --json retorna todos os campos para task, ask e plan', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const empty = await opc(ctx, ['task-resume-candidate', '--json']);
  assert.deepEqual(JSON.parse(empty.stdout), { available: false, sessionId: 'claude-f2a', candidate: null });
  for (const kind of ['task', 'ask', 'plan']) {
    const r = await opc(ctx, [kind, `something for ${kind}`]);
    const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
    const payload = JSON.parse((await opc(ctx, ['task-resume-candidate', '--json', '--kind', kind])).stdout);
    assert.equal(payload.available, true, kind);
    assert.equal(payload.sessionId, 'claude-f2a', kind);
    assert.deepEqual(payload.candidate, {
      id: job.id,
      kind: job.kind,
      status: job.status,
      title: job.title,
      summary: job.summary,
      sessionID: job.sessionID,
      completedAt: job.completedAt,
      updatedAt: job.updatedAt,
    }, kind);
  }
});

test('um segundo job na mesma sessão OpenCode falha imediatamente (exit 2)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'slow' });
  const bg = await opc(ctx, ['task', '--background', '--json', 'long']);
  const id = JSON.parse(bg.stdout).jobId;
  const running = await waitFor(() => jobIn(ctx.env, ctx.cwd, id)?.sessionID, { timeoutMs: 20000, intervalMs: 100, message: 'session id' });
  const again = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--resume ${running} more` });
  assert.equal(again.code, 2);
  assert.match(again.stdout + again.stderr, /SESSION_BUSY/);
});

test('troca de perfil ao retomar: read-only → escrita recusada; write → read-only aplicado', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const ro = await opc(ctx, ['task', 'read only first']);
  const roJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(ro.stderr));
  const refused = await opc(ctx, ['task', '--write', '--resume', roJob.id, 'now write']);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout + refused.stderr, /PROFILE_SWITCH_UNSUPPORTED/);
  assert.equal(requestsTo(ctx.env, 'PATCH', /^\/api\/session\//).length, 0);
  const wr = await opc(ctx, ['task', '--write', 'write first']);
  const wrJob = jobIn(ctx.env, ctx.cwd, jobIdFrom(wr.stderr));
  const back = await opc(ctx, ['task', '--resume', wrJob.id, 'now read only']);
  assert.equal(back.code, 0, back.stderr);
  const [patch] = requestsTo(ctx.env, 'PATCH', `/api/session/${wrJob.sessionID}`);
  assert.ok(patch.body.permissions.length > 0);
  const posts = requestsTo(ctx.env, 'POST', '/api/session');
  assert.ok(posts.length > 0);
  assert.ok(posts.at(-1).body.permissions.length > 0);
  const same = await opc(ctx, ['task', '--resume', wrJob.id, 'still read only']);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(requestsTo(ctx.env, 'PATCH', `/api/session/${wrJob.sessionID}`).length, 1);
});
