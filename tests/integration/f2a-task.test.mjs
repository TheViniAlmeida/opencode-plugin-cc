import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { F2A_MODEL_ID, F2A_PROVIDER, jobIdFrom, jobIn, opc, requestsTo, setupF2a } from '../helpers.mjs';
import { READ_ONLY_RULES } from '../fixtures/expected-rules-f2a.mjs';

test('task foreground: ok turn prints the final text, exit 0, read-only rules on POST /session', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'say hello\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^fake-opencode: ok\n/);
  assert.match(r.stderr, /\[opc\] tarefa task-[0-9a-z]+-[0-9a-z]{6} iniciada/);
  const [post] = requestsTo(ctx.env, 'POST', '/session');
  assert.deepEqual(post.body.permission, READ_ONLY_RULES);
  assert.match(post.body.title, /^OPC: task: say hello$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'say hello' }]);
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

test('task: StructuredOutputError → exit 7 with the raw text', async (t) => {
  const ctx = setupF2a(t, { scenario: 'structured-error' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'give me json' });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stdout, /StructuredOutputError \(recoverable\)/);
  assert.match(r.stdout, /Saída bruta \(falha na saída estruturada\):\n\nraw text answer/);
});

test('--model with slashes reaches prompt_async intact; --effort is sent as variant', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: `--model ${F2A_PROVIDER}/${F2A_MODEL_ID} --effort high check` });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.deepEqual(prompt.body.model, { providerID: F2A_PROVIDER, modelID: F2A_MODEL_ID });
  assert.equal(prompt.body.variant, 'high');
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'check' }]);
});

test('invalid --effort is refused before any session (exit 2)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--effort', 'ultra-max', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /UNKNOWN_VARIANT/);
  assert.equal(requestsTo(ctx.env, 'POST', '/session').length, 0);
});

test('--variant and --effort conflict even when their values match', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['task', '--variant', 'high', '--effort', 'high', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /CONFLICT/);
  assert.equal(requestsTo(ctx.env, 'POST', '/session').length, 0);
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
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  const text = prompt.body.parts[0].text;
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
  const [post] = requestsTo(ctx.env, 'POST', '/session');
  assert.deepEqual(post.body.permission, READ_ONLY_RULES);
  assert.match(post.body.title, /^OPC: plan: add a cache$/);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.parts[0].text, /\*\*Files\*\*/);
  assert.match(prompt.body.parts[0].text, /Task:\nadd a cache/);
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
  assert.match(readFileSync(job.logFile, 'utf8'), /final output truncated in the log/);
});
