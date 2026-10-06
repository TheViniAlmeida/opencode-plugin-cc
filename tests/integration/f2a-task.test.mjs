import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { F2A_MODEL_ID, F2A_PROVIDER, jobIdFrom, jobIn, opc, requestsTo, setupF2a } from '../helpers.mjs';

test('task foreground: V2 prompt prints final text and creates an explicit session', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'say hello\n' });
  assert.equal(r.code, 0, `stdout=${r.stdout.length} stderr=${r.stderr.length}; ${r.stderr + r.stdout}`);
  assert.match(r.stdout, /^ok\n/);
  assert.match(r.stderr, /\[opc\] tarefa task-[0-9a-z]+-[0-9a-z]{6} iniciada/);
  const [post] = requestsTo(ctx.env, 'POST', '/api/session');
  assert.ok(post.body.permissions.length > 0);
  assert.deepEqual(post.body.model, { providerID: F2A_PROVIDER, id: F2A_MODEL_ID });
  assert.match(post.body.title, /^OPC: task: say hello$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/api\/session\/[^/]+\/prompt$/);
  assert.match(prompt.body.id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(prompt.body.text, 'say hello');
  const job = jobIn(ctx.env, ctx.cwd, jobIdFrom(r.stderr));
  assert.equal(job.status, 'completed');
  assert.equal(job.phase, 'done');
  assert.equal(job.permissionProfile, 'read-only');
});

test('task: structured result is stored and shown', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured' });
  const r = await opc(ctx, ['task', '--json', '--raw-args-stdin'], { stdin: 'give me json' });
  assert.equal(r.code, 0, r.stderr);
  const { job } = JSON.parse(r.stdout);
  assert.deepEqual(job.result.structured, { verdict: 'approve', count: 3 });
  assert.equal(job.result.toolsRan, false);
});

test('task: non-JSON V2 text remains a normal result', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured-error' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'give me json' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /raw text answer that is not valid JSON/);
});

test('--model with slashes reaches the V2 session; --effort is sent as variant', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--model ${F2A_PROVIDER}/${F2A_MODEL_ID} --effort high check` });
  assert.equal(r.code, 0, r.stderr);
  const [session] = requestsTo(ctx.env, 'POST', '/api/session');
  const [prompt] = requestsTo(ctx.env, 'POST', /\/api\/session\/[^/]+\/prompt$/);
  assert.deepEqual(session.body.model, { providerID: F2A_PROVIDER, id: F2A_MODEL_ID, variant: 'high' });
  assert.equal(prompt.body.text, 'check');
});

test('invalid --effort is refused before any session (exit 2)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--effort', 'ultra-max', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /UNKNOWN_VARIANT/);
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
});

test('--variant and --effort conflict even when their values match', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--variant', 'high', '--effort', 'high', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /CONFLICT/);
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
});

test('--resume with --fresh is a usage error (exit 2) without contacting the server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--resume', '--fresh', 'go']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /mutuamente exclusivos/);
  assert.equal(existsSync(ctx.env.FAKE_OPENCODE_STATE), false);
});

test('OPC_INSIDE_SERVER=1 refuses to create jobs (exit 4) and never starts a server', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', 'anything'], { env: { OPC_INSIDE_SERVER: '1' } });
  assert.equal(r.code, 4);
  assert.match(r.stdout + r.stderr, /INSIDE_SERVER/);
  assert.equal(existsSync(ctx.env.FAKE_OPENCODE_STATE), false);
});

test('<project_context> from the workspace config is prepended to the prompt', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  writeFileSync(join(ctx.cwd, '.opc.json'), JSON.stringify({ project: { goal: 'Ship opc', scope: ['plugins/', 'tests/'], taskTypes: ['ask', 'plan'] } }));
  const r = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: 'where is the runner?' });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/api\/session\/[^/]+\/prompt$/);
  const text = prompt.body.text;
  assert.ok(text.startsWith('<project_context>\ngoal: Ship opc\nscope: plugins/, tests/\ntask types: ask, plan\n</project_context>\n\n'), text.slice(0, 200));
  assert.ok(text.endsWith('Question:\nwhere is the runner?\n'), text.slice(-200));
});

test('ask and plan are read-only: --write is refused (exit 2); templates are applied', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const refused = await opc(ctx, ['plan', '--write', 'do it']);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout + refused.stderr, /READ_ONLY_KIND/);
  const r = await opc(ctx, ['plan', '--raw-args-stdin'], { stdin: 'add a cache' });
  assert.equal(r.code, 0, r.stderr);
  const [post] = requestsTo(ctx.env, 'POST', '/api/session');
  assert.ok(post.body.permissions.length > 0);
  assert.match(post.body.title, /^OPC: plan: add a cache$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/api\/session\/[^/]+\/prompt$/);
  assert.match(prompt.body.text, /\*\*Files\*\*/);
  assert.match(prompt.body.text, /Task:\nadd a cache/);
});

test('large output (>1 MB): printed whole, job log stays under 5 MB', async (t) => {
  const ctx = setupF2a(t, { scenario: 'large-output' });
  const r = await opc(ctx, ['task', 'big'], { timeoutMs: 120000 });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.length > 1_000_000);
  assert.match(r.stdout, /END-OF-LARGE-OUTPUT/);
  const id = jobIdFrom(r.stderr);
  const job = jobIn(ctx.env, ctx.cwd, id);
  assert.ok(statSync(job.logFile).size <= 5 * 1024 * 1024);
  assert.match(readFileSync(job.logFile, 'utf8'), /saída final truncada no log/);
});
