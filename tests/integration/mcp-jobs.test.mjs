import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { isActive, readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { EXIT_STATE } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { ensurePrivateDir, resolveWorkspaceRoot, updateState, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { installSessionApi, SESSION_API_ROUTES } from '../fixtures/fake-session-api.mjs';
import slowScenario from '../fixtures/scenarios/slow.mjs';
import {
  cliJson, F2A_MODEL, F2A_POLICY, F2A_PROVIDER, findJobId, FIXTURE_MODELS,
  makeWorkspace, readFakeState, registerStopper, startMcpClient, testEnv,
  writeGlobalConfig, writeTestConfig,
} from '../helpers.mjs';

const EVIL = '--write\n$(touch pwned) `touch pwned2` "double" \'single\' ção ✓';

test('cenário lento permite uma janela estável para consultar e cancelar o job', async () => {
  const previous = process.env.FAKE_SLOW_MS;
  let delayMs;
  try {
    process.env.FAKE_SLOW_MS = '30000';
    await slowScenario.onPromptAsync({ emitTurn: async (_sessionId, options) => { delayMs = options.delayMs; } }, 'ses_test');
  } finally {
    if (previous === undefined) delete process.env.FAKE_SLOW_MS;
    else process.env.FAKE_SLOW_MS = previous;
  }
  assert.equal(delayMs, 30000);
});

test('fake oferece a rota de tarefas da sessão para comparar MCP e CLI', () => {
  assert.ok(SESSION_API_ROUTES.includes('GET /session/:id/todo'));
  const fake = { state: {}, persist() {}, emit() {} };
  const api = installSessionApi(fake);
  const session = fake.createSession({ title: 'MCP session' });
  assert.deepEqual(api.handle('GET', `/session/${session.id}/todo`, new URLSearchParams(), null), { status: 200, body: [] });
});

function setup(t, scenario = 'ok', extraEnv = {}) {
  const env = testEnv(t, { scenario });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY });
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws, ...extraEnv };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close());
  return { env, ws, c };
}

function jobIdIn(envelope, kind) {
  return findJobId(envelope.data, kind);
}

function assertJobParity(mcp, cli, jobId) {
  assert.equal(mcp?.job?.id, jobId);
  assert.equal(cli?.job?.id, jobId);
  assert.equal(typeof mcp.job.status, 'string');
  assert.ok(Object.hasOwn(mcp.job, 'result'));
  assert.equal(mcp.job.status, cli.job.status);
  assert.deepEqual(mcp.job.result, cli.job.result);
  assert.equal(mcp.job.errorCode, cli.job.errorCode);
}

function assertActiveJob(data, jobId) {
  assert.equal(data?.job?.id, jobId);
  assert.ok(isActive(data.job), 'job deve permanecer ativo após wait_timeout');
}

function assertCancelledJob(data, jobId) {
  assert.equal(data?.job?.id, jobId);
  assert.equal(data.job.status, 'cancelled');
}

function assertReadOnlyPermissions(permissions) {
  assert.ok(Array.isArray(permissions));
  assert.deepEqual(permissions[0], { permission: '*', pattern: '*', action: 'deny' });
  const readable = new Set(['read', 'glob', 'list', 'lsp', 'skill', 'todowrite']);
  for (const rule of permissions) {
    if (rule.action !== 'deny') {
      assert.equal(rule.action, 'allow');
      assert.ok(readable.has(rule.permission), `permissão não é somente leitura: ${rule.permission}`);
    }
  }
}

test('a paridade de status rejeita estado e outcome divergentes', () => {
  const expected = { job: { id: 'ask-1', status: 'completed', result: { finalText: 'ok' }, errorCode: null } };
  assert.throws(() => assertJobParity({ job: { ...expected.job, status: 'running' } }, expected, 'ask-1'), { name: 'AssertionError' });
  assert.throws(() => assertJobParity({ job: { ...expected.job, result: { finalText: 'failed' } } }, expected, 'ask-1'), { name: 'AssertionError' });
});

test('a espera limitada exige job ativo antes de cancelar e cancelado depois', () => {
  assert.throws(() => assertActiveJob({ job: { id: 'task-1', status: 'cancelled' } }, 'task-1'), { name: 'AssertionError' });
  assert.throws(() => assertCancelledJob({ job: { id: 'task-1', status: 'running' } }, 'task-1'), { name: 'AssertionError' });
});

test('perfil somente leitura rejeita permissões de escrita posteriores', () => {
  assert.throws(() => assertReadOnlyPermissions([
    { permission: '*', pattern: '*', action: 'deny' },
    { permission: 'edit', pattern: '*', action: 'allow' },
  ]), { name: 'AssertionError' });
});

test('opc_task inicia job somente leitura e envia o prompt integralmente', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const started = await c.callTool('opc_task', { prompt: EVIL });
  assert.equal(started.envelope.exitCode, 0);
  assert.equal(started.isError, false);
  const jobId = jobIdIn(started.envelope, 'task');
  assert.ok(jobId);
  const done = await c.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 60 });
  assert.equal(done.envelope.exitCode, 0);
  const requests = readFakeState(env).requests;
  const prompt = requests.find((request) => request.method === 'POST' && /\/session\/[^/]+\/prompt_async$/.test(request.path));
  assert.ok(prompt?.body.parts.some((part) => typeof part.text === 'string' && part.text.includes(EVIL)));
  const created = requests.find((request) => request.method === 'POST' && request.path === '/session');
  assertReadOnlyPermissions(created.body.permission);
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(ws, 'pwned2')), false);
});

test('opc_job_result e opc_job_status coincidem com a CLI para o mesmo job', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const started = await c.callTool('opc_ask', { prompt: 'say ok' });
  assert.equal(started.envelope.exitCode, 0);
  const jobId = jobIdIn(started.envelope, 'ask');
  assert.ok(jobId);
  const waited = await c.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 60 });
  assert.equal(waited.envelope.exitCode, 0);
  const resultMcp = await c.callTool('opc_job_result', { jobId });
  const resultCli = await cliJson(['result', jobId], { env, cwd: ws });
  assert.equal(resultMcp.envelope.exitCode, resultCli.code);
  assert.deepEqual(resultMcp.envelope.data, resultCli.data);
  const statusMcp = await c.callTool('opc_job_status', { jobId });
  const statusCli = await cliJson(['status', jobId], { env, cwd: ws });
  assert.equal(statusMcp.envelope.exitCode, statusCli.code);
  assertJobParity(statusMcp.envelope.data, statusCli.data, jobId);
});

test('espera de tarefa lenta tem limite e atende outras requisições', async (t) => {
  const { env, ws, c } = setup(t, 'slow', { FAKE_SLOW_MS: '30000' });
  await c.initialize();
  let settled = false;
  const waiting = c.callTool('opc_task', { prompt: 'slow work', wait: true, waitTimeoutSec: 1 })
    .finally(() => { settled = true; });
  const ping = await c.request('ping');
  assert.deepEqual(ping.result, {});
  assert.equal(settled, false);
  const waited = await waiting;
  assert.equal(waited.envelope.exitCode, 6);
  assert.equal(waited.envelope.state, 'wait_timeout');
  assert.equal(waited.isError, false);
  const jobId = jobIdIn(waited.envelope, 'task');
  assert.ok(jobId);
  const active = await c.callTool('opc_job_status', { jobId });
  assert.equal(active.envelope.exitCode, 0);
  assertActiveJob(active.envelope.data, jobId);
  const cancelled = await c.callTool('opc_job_cancel', { jobId });
  assert.equal(cancelled.envelope.exitCode, 0);
  const status = await cliJson(['status', jobId], { env, cwd: ws });
  assert.equal(status.code, 0);
  assertCancelledJob(status.data, jobId);
});

test('recusa por política tem o mesmo código no MCP e na CLI', async (t) => {
  const { env, ws, c } = setup(t);
  writeTestConfig(env, { policy: { models: { allow: [], deny: ['*'] }, providers: { allow: [], deny: ['*'] } } });
  await c.initialize();
  const mcp = await c.callTool('opc_task', { prompt: 'x', model: F2A_MODEL });
  const cli = await cliJson(['task', '--model', F2A_MODEL, '--background', '--', 'x'], { env, cwd: ws });
  assert.equal(cli.code, 4);
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.equal(mcp.envelope.state, EXIT_STATE[cli.code]);
  assert.equal(mcp.isError, true);
});

test('proteção contra recursão recusa ferramentas de jobs como na CLI', async (t) => {
  const { env, ws, c } = setup(t, 'ok', { OPC_INSIDE_SERVER: '1' });
  await c.initialize();
  const cliEnv = { ...env, OPC_INSIDE_SERVER: '1' };
  const cases = [
    ['opc_task', { prompt: 'x' }, ['task', '--background', '--', 'x']],
    ['opc_ask', { prompt: 'x' }, ['ask', '--background', '--', 'x']],
    ['opc_plan', { prompt: 'x' }, ['plan', '--background', '--', 'x']],
    ['opc_subagent', { prompt: 'x', agents: ['general'] }, ['subagent', '--agent', 'general', '--background', '--', 'x']],
    ['opc_orchestrate', { task: 'x' }, ['orchestrate', '--background', '--', 'x']],
    ['opc_conclave', { question: 'x', models: [FIXTURE_MODELS.fast, FIXTURE_MODELS.strong] },
      ['conclave', '--models', `${FIXTURE_MODELS.fast},${FIXTURE_MODELS.strong}`, '--background', '--', 'x']],
  ];
  for (const [name, args, cliArgs] of cases) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env: cliEnv, cwd: ws });
    assert.equal(cli.code, 4, name);
    assert.equal(mcp.envelope.exitCode, cli.code, name);
    assert.equal(mcp.envelope.state, 'policy_denied', name);
    assert.equal(mcp.envelope.error?.code, 'INSIDE_SERVER', name);
    assert.equal(mcp.isError, true, name);
  }
  let requests = [];
  try { requests = readFakeState(env).requests ?? []; } catch { requests = []; }
  assert.equal(requests.filter((request) => request.method === 'POST' && request.path === '/session').length, 0);
});

test('jobs MCP herdam a sessão Claude registrada pelo processo pai', async (t) => {
  const env = testEnv(t, { scenario: 'ok' });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY });
  const stateDir = workspaceStateDir(env.OPC_DATA_DIR, resolveWorkspaceRoot(ws));
  ensurePrivateDir(stateDir);
  const identity = getProcessIdentity(process.pid);
  await updateState(stateDir, (state) => {
    state.claudeSessions.push({ sessionId: 'claude-mcp-parent', pid: process.pid, pidStartTime: identity.startTime, startedAt: new Date().toISOString() });
  });
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close());
  await c.initialize();
  const started = await c.callTool('opc_task', { prompt: 'x' });
  assert.equal(started.envelope.exitCode, 0);
  const jobId = jobIdIn(started.envelope, 'task');
  assert.ok(jobId);
  assert.equal(readJob(stateDir, jobId).claudeSessionId, 'claude-mcp-parent');
});

test('ferramentas de sessão coincidem com os comandos da CLI', async (t) => {
  const { env, ws, c } = setup(t);
  await c.initialize();
  const created = await c.callTool('opc_session_new', { title: 'MCP session' });
  assert.equal(created.envelope.exitCode, 0);
  const sessionId = created.envelope.data?.session?.id;
  assert.ok(sessionId);
  for (const [name, action] of [
    ['opc_session_show', 'show'], ['opc_session_children', 'children'],
    ['opc_session_diff', 'diff'], ['opc_session_todo', 'todo'],
  ]) {
    const mcp = await c.callTool(name, { sessionId });
    const cli = await cliJson(['session', action, sessionId], { env, cwd: ws });
    assert.equal(cli.code, 0, name);
    assert.equal(mcp.envelope.exitCode, cli.code, name);
    assert.deepEqual(mcp.envelope.data, cli.data, name);
  }
  const listMcp = await c.callTool('opc_session_list');
  const listCli = await cliJson(['sessions'], { env, cwd: ws });
  assert.equal(listCli.code, 0);
  assert.equal(listMcp.envelope.exitCode, listCli.code);
  assert.deepEqual(listMcp.envelope.data, listCli.data);
});

test('subagent, orchestrate e conclave retornam jobs como os comandos da CLI', async (t) => {
  const { env, ws, c } = setup(t, 'conclave-opinion');
  await c.initialize();
  const cases = [
    ['opc_subagent', { prompt: 'x', agents: ['general'] }, ['subagent', '--agent', 'general', '--background', '--', 'x'], 'sub'],
    ['opc_orchestrate', { task: 'x' }, ['orchestrate', '--background', '--', 'x'], 'orch'],
    ['opc_conclave', { question: 'x', models: [FIXTURE_MODELS.fast, FIXTURE_MODELS.strong] },
      ['conclave', '--models', `${FIXTURE_MODELS.fast},${FIXTURE_MODELS.strong}`, '--background', '--', 'x'], 'conc'],
  ];
  for (const [name, args, cliArgs, kind] of cases) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env, cwd: ws });
    assert.equal(cli.code, 0, name);
    assert.equal(mcp.envelope.exitCode, cli.code, name);
    assert.ok(jobIdIn(mcp.envelope, kind), name);
    assert.ok(findJobId(cli.data, kind), name);
  }
});
