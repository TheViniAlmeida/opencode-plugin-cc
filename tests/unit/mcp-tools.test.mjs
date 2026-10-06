import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { validateInput } from '../../plugins/opc/scripts/lib/mcp-schema.mjs';
import {
  ALLOWED_COMMANDS,
  buildEnvelope,
  commandKey,
  createCaptureStream,
  createToolCaller,
  emptyStdin,
  MAX_WAIT_SEC,
  resolveClaudeSessionId,
  SERVER_INSTRUCTIONS,
  TOOL_NAMES,
  TOOLS,
} from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { OpcError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const EVIL = '--write\n$(touch pwned) `id` "q" \'s\' ção ✓';

const CASES = [
  ['opc_models', { provider: 'omni', allowed: true, all: true, verbose: true }, ['models', 'omni', '--allowed', '--all', '--verbose', '--json']],
  ['opc_providers', { all: true }, ['providers', '--all', '--json']],
  ['opc_agents', { mode: 'subagent', verbose: true, allowed: true }, ['agents', '--mode', 'subagent', '--verbose', '--allowed', '--json']],
  ['opc_catalog', { kind: 'skills' }, ['catalog', 'skills', '--json']],
  ['opc_config_get', { key: 'policy.approver' }, ['config', 'get', 'policy.approver', '--json']],
  ['opc_config_get', {}, ['config', 'get', '--json']],
  ['opc_task', { prompt: EVIL, model: 'p/m/x', agent: 'build', variant: 'high', tier: 'heavy', write: true, profile: 'custom:npm-test-only', timeoutSec: 60 },
    ['task', '--model', 'p/m/x', '--agent', 'build', '--variant', 'high', '--tier', 'heavy', '--write', '--profile', 'custom:npm-test-only', '--timeout', '60', '--background', '--json', '--', EVIL]],
  ['opc_task', { resume: 'ses_abc', wait: true, waitTimeoutSec: 30 }, ['task', '--resume-id', 'ses_abc', '--wait-timeout', '30', '--json']],
  ['opc_task', { prompt: 'x', resumeLast: true, fresh: true, wait: true }, ['task', '--resume-last', '--fresh', '--wait-timeout', '120', '--json', '--', 'x']],
  ['opc_ask', { prompt: 'why?', model: 'fast', variant: 'low', tier: 'light' }, ['ask', '--model', 'fast', '--variant', 'low', '--tier', 'light', '--background', '--json', '--', 'why?']],
  ['opc_plan', { prompt: 'plan it', resume: 'plan-mabc12-a1b2c3', timeoutSec: 5, wait: true, waitTimeoutSec: 9 }, ['plan', '--resume-id', 'plan-mabc12-a1b2c3', '--timeout', '5', '--wait-timeout', '9', '--json', '--', 'plan it']],
  ['opc_subagent', { prompt: 'p', agents: ['general', 'explore'], models: ['a/b', 'c/d'] }, ['subagent', '--agent', 'general,explore', '--model', 'a/b,c/d', '--background', '--json', '--', 'p']],
  ['opc_orchestrate', { task: 't', planner: 'strong', maxSubtasks: 3, synthesizer: 'claude', write: true }, ['orchestrate', '--planner', 'strong', '--max', '3', '--synthesizer', 'claude', '--write', '--background', '--json', '--', 't']],
  ['opc_conclave', { question: 'q?', models: ['a/b', 'c/d'], mode: 'debate', rounds: 2, judge: 'claude', quorum: 2, allowJudgeMember: true },
    ['conclave', '--models', 'a/b,c/d', '--mode', 'debate', '--rounds', '2', '--judge', 'claude', '--quorum', '2', '--allow-judge-member', '--background', '--json', '--', 'q?']],
  ['opc_conclave', { question: 'q?', pool: 'default', wait: true, waitTimeoutSec: MAX_WAIT_SEC }, ['conclave', '--pool', 'default', '--wait-timeout', String(MAX_WAIT_SEC), '--json', '--', 'q?']],
  ['opc_session_list', { all: true }, ['sessions', '--all', '--json']],
  ['opc_session_show', { sessionId: 'ses_1' }, ['session', 'show', 'ses_1', '--json']],
  ['opc_session_new', { title: 'My title', agent: 'plan', model: 'a/b' }, ['session', 'new', '--title', 'My title', '--agent', 'plan', '--model', 'a/b', '--json']],
  ['opc_session_fork', { sessionId: 'ses_1', messageId: 'msg_2' }, ['session', 'fork', 'ses_1', '--before', 'msg_2', '--json']],
  ['opc_session_summarize', { sessionId: 'ses_1', model: 'fast' }, ['session', 'summarize', 'ses_1', '--model', 'fast', '--json']],
  ['opc_session_children', { sessionId: 'ses_1' }, ['session', 'children', 'ses_1', '--json']],
  ['opc_session_diff', { sessionId: 'ses_1' }, ['session', 'diff', 'ses_1', '--json']],
  ['opc_job_status', { jobId: 'task-1', all: true }, ['status', 'task-1', '--all', '--json']],
  ['opc_job_status', { jobId: 'task-1', wait: true, timeoutSec: 10 }, ['status', 'task-1', '--wait', '--timeout-ms', '10000', '--json']],
  ['opc_job_result', { jobId: 'task-1' }, ['result', 'task-1', '--json']],
  ['opc_job_cancel', {}, ['cancel', '--json']],
  ['opc_permissions_list', {}, ['permissions', 'list', '--json']],
  ['opc_permissions_reply', { requestId: 'per_1', reply: 'reject', message: '--no thanks', confirmedByUser: true }, ['permissions', 'reply', 'per_1', 'reject', '--confirmed-by-user', '--json', '--', '--no thanks']],
  ['opc_permissions_reply', { requestId: 'per_1', reply: 'once' }, ['permissions', 'reply', 'per_1', 'once', '--json']],
  ['opc_permissions_answer', { requestId: 'que_1', answers: ['Yes', '--other'] }, ['permissions', 'answer', 'que_1', '--json', '--', 'Yes', '--other']],
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function tempDir(t) {
  return trackTempDir(t, makeTempDir('opc-f5-tools-'));
}

function spyDispatch(result = { exitCode: 0, stdout: '{"ok":true}\n' }) {
  const calls = [];
  const dispatch = async (argv, io) => {
    calls.push({ argv, io });
    if (result.stdout) io.stdout.write(result.stdout);
    if (result.stderr) io.stderr.write(result.stderr);
    if (result.throw) {
      io.onError(result.throw);
      io.stderr.write('# opc error\n');
      return result.throw.exitCode;
    }
    return result.exitCode;
  };
  return { dispatch, calls };
}

test('the tool set is exactly the documented list (24 tools)', () => {
  assert.ok(!TOOL_NAMES.includes('opc_session_todo'));
  assert.equal(TOOL_NAMES.length, 24);
  assert.deepEqual(TOOL_NAMES, [
    'opc_models', 'opc_providers', 'opc_agents', 'opc_catalog', 'opc_config_get',
    'opc_task', 'opc_ask', 'opc_plan', 'opc_subagent', 'opc_orchestrate', 'opc_conclave',
    'opc_session_list', 'opc_session_show', 'opc_session_new', 'opc_session_fork', 'opc_session_summarize', 'opc_session_children', 'opc_session_diff',
    'opc_job_status', 'opc_job_result', 'opc_job_cancel',
    'opc_permissions_list', 'opc_permissions_reply', 'opc_permissions_answer',
  ]);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.inputSchema.properties.cwd, `${tool.name} accepts cwd`);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
  }
});

test('every tool has at least one argv case and every case matches exactly', () => {
  const covered = new Set(CASES.map(([name]) => name));
  assert.deepEqual([...TOOL_NAMES].filter((name) => !covered.has(name)), []);
  for (const [name, args, expected] of CASES) {
    const tool = byName.get(name);
    assert.deepEqual(validateInput(tool.inputSchema, args), [], `${name} sample args are valid`);
    assert.deepEqual(tool.toArgv(args), expected, name);
  }
});

test('no tool reaches a command outside the allowlist (no config writes, revert, stop-server, review, transfer)', () => {
  for (const [name, args] of CASES) {
    const argv = byName.get(name).toArgv(args);
    assert.ok(ALLOWED_COMMANDS.includes(commandKey(argv)), `${name} → ${commandKey(argv)}`);
    if (argv[0] === 'config') assert.equal(argv[1], 'get');
    assert.ok(!argv.slice(0, argv.indexOf('--json')).includes('--tty-confirm'));
  }
  for (const forbidden of ['config set', 'config unset', 'config add', 'config remove', 'config init', 'session revert', 'session unrevert', 'setup', 'review', 'adversarial-review', 'transfer', 'gc', 'command', 'attach', 'monitor']) {
    assert.ok(!ALLOWED_COMMANDS.includes(forbidden), forbidden);
  }
  assert.equal(TOOL_NAMES.filter((name) => /config_(set|unset|add|remove|init)|revert|stop|review|transfer|setup/.test(name)).length, 0);
});

test('schemas reject "always", flag-like identifiers and out-of-range waits', () => {
  const reply = byName.get('opc_permissions_reply');
  assert.ok(validateInput(reply.inputSchema, { requestId: 'per_1', reply: 'always' }).length > 0);
  assert.ok(validateInput(byName.get('opc_config_get').inputSchema, { key: '--tty-confirm' }).length > 0);
  assert.ok(validateInput(byName.get('opc_task').inputSchema, { prompt: 'x', model: '--write' }).length > 0);
  assert.ok(validateInput(byName.get('opc_task').inputSchema, { prompt: 'x', wait: true, waitTimeoutSec: MAX_WAIT_SEC + 1 }).length > 0);
  assert.ok(validateInput(byName.get('opc_session_show').inputSchema, { sessionId: '-x' }).length > 0);
  assert.ok(validateInput(byName.get('opc_conclave').inputSchema, { question: 'q?', mode: 'review' }).length > 0);
  assert.deepEqual(validateInput(byName.get('opc_conclave').inputSchema, { question: 'q?', mode: 'debate' }), []);
  assert.ok(validateInput(byName.get('opc_orchestrate').inputSchema, { task: 'x', maxSubtasks: 11 }).length > 0);
  assert.deepEqual(validateInput(byName.get('opc_orchestrate').inputSchema, { task: 'x', maxSubtasks: 10 }), []);
  assert.throws(() => reply.toArgv({ requestId: 'per_1', reply: 'always' }), (e) => e.code === 'INVALID_ARGUMENTS' && e.exitCode === 2);
  assert.throws(() => byName.get('opc_session_new').toArgv({ title: '-oops' }), (e) => e.code === 'INVALID_ARGUMENTS');
});

test('the tool caller validates, maps argv and calls the same dispatcher with an isolated stdio', async (t) => {
  const cwd = tempDir(t);
  const spy = spyDispatch();
  const callTool = createToolCaller({ dispatch: spy.dispatch, env: { A: '1' }, defaultCwd: cwd, ppid: 1, resolveSessionId: () => 'claude-session-1' });
  const res = await callTool(byName.get('opc_models'), { allowed: true });
  assert.equal(res.isError, false);
  assert.deepEqual(JSON.parse(res.content[0].text), { exitCode: 0, state: 'ok', data: { ok: true } });
  assert.equal(spy.calls.length, 1);
  const { argv, io } = spy.calls[0];
  assert.deepEqual(argv, ['models', '--allowed', '--json']);
  assert.equal(io.cwd, cwd);
  assert.equal(io.env.A, '1');
  assert.equal(io.env.OPC_COMPANION_SESSION_ID, 'claude-session-1');
  assert.notEqual(io.stdin, process.stdin);
  assert.notEqual(io.stdout, process.stdout);
  assert.equal(io.stdin.isTTY, false);
  assert.equal(typeof io.onError, 'function');
});

test('invalid arguments and bad cwd never reach the dispatcher', async (t) => {
  const spy = spyDispatch();
  const callTool = createToolCaller({ dispatch: spy.dispatch, env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null });
  const bad = await callTool(byName.get('opc_permissions_reply'), { requestId: 'per_1', reply: 'always' });
  assert.equal(bad.isError, true);
  const envelope = JSON.parse(bad.content[0].text);
  assert.equal(envelope.exitCode, 2);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
  const cwdBad = await callTool(byName.get('opc_models'), { cwd: 'relative/dir' });
  assert.equal(JSON.parse(cwdBad.content[0].text).error.code, 'INVALID_CWD');
  const suppliedPath = '/tmp/segredo-do-operador/inexistente';
  const absoluteBad = await callTool(byName.get('opc_models'), { cwd: suppliedPath });
  assert.equal(JSON.parse(absoluteBad.content[0].text).error.code, 'INVALID_CWD');
  assert.ok(!absoluteBad.content[0].text.includes(suppliedPath));
  const unknownField = 'entradaNaoPrevistaComValorExtenso';
  const unknown = await callTool(byName.get('opc_models'), { [unknownField]: true });
  assert.equal(JSON.parse(unknown.content[0].text).error.code, 'INVALID_ARGUMENTS');
  assert.ok(!unknown.content[0].text.includes(unknownField));
  assert.equal(spy.calls.length, 0);
});

test('user-provided text is fully masked in dispatcher output and errors', async (t) => {
  const supplied = 'modelo-invalido-com-id-extenso';
  const callTool = createToolCaller({
    dispatch: spyDispatch({ throw: new OpcError('POLICY_DENIED', `Modelo negado: ${supplied}`, { exitCode: 4 }) }).dispatch,
    env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null,
  });
  const result = await callTool(byName.get('opc_task'), { prompt: 'verificar', model: supplied });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.error.code, 'POLICY_DENIED');
  assert.equal(envelope.error.message, 'Modelo negado: ***');
  assert.ok(!result.content[0].text.includes(supplied));
  const short = 'abc';
  const echoed = createToolCaller({ dispatch: spyDispatch({ exitCode: 7, stdout: `{"detail":"${short}"}`, stderr: `falhou: ${short}` }).dispatch,
    env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null });
  const echoedResult = await echoed(byName.get('opc_task'), { prompt: short });
  assert.equal(JSON.parse(echoedResult.content[0].text).data.detail, '***');
  assert.equal(JSON.parse(echoedResult.content[0].text).error.message, 'falhou: ***');
  assert.ok(!echoedResult.content[0].text.includes(short));
  const rejected = createToolCaller({ dispatch: spyDispatch().dispatch, env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null });
  const invalidTool = { ...byName.get('opc_task'), toArgv: () => { throw new OpcError('INVALID_ARGUMENTS', `entrada: ${short}`, { exitCode: 2 }); } };
  assert.equal(JSON.parse((await rejected(invalidTool, { prompt: short })).content[0].text).error.message, 'entrada: ***');
});

test('typed errors become isError envelopes with code and exit code; waiting states are not errors', async (t) => {
  const cwd = tempDir(t);
  const denied = createToolCaller({ dispatch: spyDispatch({ throw: new OpcError('POLICY_DENIED', 'modelo negado: x', { exitCode: 4 }) }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const res = await denied(byName.get('opc_task'), { prompt: 'x', model: 'x/y' });
  assert.equal(res.isError, true);
  assert.deepEqual(JSON.parse(res.content[0].text), { exitCode: 4, state: 'policy_denied', error: { code: 'POLICY_DENIED', message: 'modelo negado: ***' } });
  const waiting = createToolCaller({ dispatch: spyDispatch({ exitCode: 3, stdout: '{"status":"waiting_permission"}' }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const w = await waiting(byName.get('opc_task'), { prompt: 'x', wait: true });
  assert.equal(w.isError, false);
  assert.equal(JSON.parse(w.content[0].text).state, 'waiting_permission');
  const failed = createToolCaller({ dispatch: spyDispatch({ exitCode: 7, stdout: '', stderr: 'job falhou: boom' }).dispatch, env: {}, defaultCwd: cwd, resolveSessionId: () => null });
  const f = await failed(byName.get('opc_job_result'), {});
  assert.equal(f.isError, true);
  assert.deepEqual(JSON.parse(f.content[0].text).error, { code: 'COMMAND_FAILED', message: 'job falhou: boom' });
});

test('a hanging dispatch is cut by the call timeout with a connection-like error', async (t) => {
  const callTool = createToolCaller({ dispatch: () => new Promise(() => {}), env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null, callTimeoutMs: 50 });
  const res = await callTool(byName.get('opc_models'), {});
  assert.equal(res.isError, true);
  assert.deepEqual(JSON.parse(res.content[0].text).error.code, 'MCP_CALL_TIMEOUT');
  assert.equal(JSON.parse(res.content[0].text).exitCode, 5);
});

test('buildEnvelope keeps raw text when stdout is not JSON and flags truncation', () => {
  const { envelope, isError } = buildEnvelope({ exitCode: 6, stdout: 'still running: task-1', truncated: true });
  assert.equal(isError, false);
  assert.deepEqual(envelope, { exitCode: 6, state: 'wait_timeout', data: 'still running: task-1', truncated: true });
  assert.equal(buildEnvelope({ exitCode: 42 }).envelope.state, 'error');
  assert.equal(buildEnvelope({ exitCode: 130 }).isError, true);
});

test('buildEnvelope redacts secret keys in the command JSON', () => {
  const { envelope } = buildEnvelope({ exitCode: 0, stdout: JSON.stringify({ provider: { options: { apiKey: 'sk-live-123456789' } } }) });
  assert.equal(envelope.data.provider.options.apiKey, '***');
});

test('buildEnvelope masks unregistered credential patterns in free text, messages and stderr', () => {
  const token = 'sk-proj-synthetic12345678';
  for (const result of [
    buildEnvelope({ exitCode: 0, stdout: `output: ${token}` }),
    buildEnvelope({ exitCode: 7, stdout: JSON.stringify({ message: `output: ${token}` }) }),
    buildEnvelope({ exitCode: 7, stderr: `failure: ${token}` }),
  ]) assert.ok(!JSON.stringify(result.envelope).includes(token));
});

test('nonzero command errors in JSON populate envelope.error for status wait and cancel', async (t) => {
  for (const [tool, args, payload] of [
    ['opc_job_status', { jobId: 'task-1', wait: true }, { error: { code: 'JOB_FAILED', message: 'job failed' } }],
    ['opc_job_cancel', { jobId: 'task-1' }, { error: 'cannot cancel' }],
  ]) {
    const callTool = createToolCaller({ dispatch: spyDispatch({ exitCode: 7, stdout: JSON.stringify(payload) }).dispatch,
      env: {}, defaultCwd: tempDir(t), resolveSessionId: () => null });
    const result = await callTool(byName.get(tool), args);
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(result.isError, true);
    assert.deepEqual(envelope.data, payload);
    assert.equal(envelope.error.code, payload.error.code ?? 'COMMAND_FAILED');
    assert.equal(envelope.error.message, payload.error.message ?? payload.error);
  }
});

test('permission reply and answer descriptions warn that data can be Markdown text', () => {
  for (const name of ['opc_permissions_reply', 'opc_permissions_answer']) {
    assert.match(byName.get(name).description, /data.*string Markdown/i);
  }
});

test('createCaptureStream caps output and emptyStdin ends immediately', async () => {
  const stream = createCaptureStream({ maxChars: 5 });
  stream.write('abc');
  stream.write('defgh');
  assert.equal(stream.text(), 'abcde');
  assert.equal(stream.truncated(), true);
  const chunks = [];
  for await (const chunk of emptyStdin()) chunks.push(chunk);
  assert.deepEqual(chunks, []);
});

test('resolveClaudeSessionId prefers the env, then the claudeSessions entry of the parent process', () => {
  assert.equal(resolveClaudeSessionId({ env: { OPC_COMPANION_SESSION_ID: 'env-id' }, cwd: '/w', ppid: 10 }), 'env-id');
  const deps = {
    getProcessIdentity: (pid) => (pid === 10 ? { pid: 10, startTime: 'st-10', cmdline: ['claude'] } : null),
    resolveDataDir: () => '/data',
    resolveWorkspaceRoot: (cwd) => cwd,
    workspaceStateDir: () => '/data/state/w',
    loadState: () => ({
      claudeSessions: [
        { sessionId: 'old', pid: 10, pidStartTime: 'st-10', startedAt: '2026-09-26T10:00:00.000Z' },
        { sessionId: 'new', pid: 10, pidStartTime: 'st-10', startedAt: '2026-09-26T11:00:00.000Z' },
        { sessionId: 'reused-pid', pid: 10, pidStartTime: 'other', startedAt: '2026-09-26T12:00:00.000Z' },
        { sessionId: 'other-proc', pid: 11, pidStartTime: 'st-11', startedAt: '2026-09-26T12:00:00.000Z' },
      ],
    }),
  };
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 10 }, deps), 'new');
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 99 }, deps), null);
  assert.equal(resolveClaudeSessionId({ env: {}, cwd: '/w', ppid: 10 }, { ...deps, loadState: () => { throw new Error('corrupt'); } }), null);
});

test('server instructions state the confirmation rules', () => {
  assert.match(SERVER_INSTRUCTIONS, /confirmedByUser=true/);
  assert.match(SERVER_INSTRUCTIONS, /"always" nunca é aceito/);
  assert.match(byName.get('opc_permissions_reply').description, /SOMENTE após o usuário aprovar explicitamente/);
});
