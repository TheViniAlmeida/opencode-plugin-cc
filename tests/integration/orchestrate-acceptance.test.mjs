// One test per F4b acceptance item (spec §13.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, readFakeState, writeGlobalConfig, readTurnLog } from '../helpers.mjs';
import { workspaceStateDir, resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';
import { listJobs } from '../../plugins/opc/scripts/lib/jobs.mjs';

const P = 'omniroute-personal/opencode-go/';
const M1 = `${P}deepseek-v4.1-flash`;
const M2 = `${P}qwen3.8-max`;
const M3 = `${P}kimi-k3`;
const modelID = (full) => full.slice(full.indexOf('/') + 1);
const DENY_ALL = { action: '*', resource: '*', effect: 'deny' };

function orchestrateConfig(extra = {}) {
  const list = [M1, M2, M3];
  return {
    defaultProvider: 'omniroute-personal',
    defaultModel: M1,
    orchestrate: { planner: M2, maxSubtasks: 5, synthesizer: 'claude' },
    routing: {
      tasks: { ask: list, plan: list, review: list, task: list },
      tiers: { light: list, heavy: list },
      fallback: { enabled: false, maxAttempts: 1, maxProviderRetries: 3, maxRetryWaitSec: 60 },
    },
    jobs: { maxActive: 8, maxParallel: 4 },
    ...extra,
  };
}

async function orchestrate(t, scenario, args) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { scenario });
  writeGlobalConfig(env, orchestrateConfig());
  const res = await runCli(['orchestrate', ...args], { env, cwd: ws, timeoutMs: 120000 });
  return { ...res, env, ws };
}

const sessionPosts = (env) => readFakeState(env).requests.filter((r) => r.method === 'POST' && r.path === '/api/session');
const subtaskTurns = (env) => readTurnLog(env).filter((e) => e.role === 'subtask');
const turnOf = (env, id) => subtaskTurns(env).find((e) => e.subtaskId === id);
const overlaps = (x, y) => x.start < y.end && y.start < x.end;

test('F4b: valid plan is decomposed, validated and executed', async (t) => {
  const { code, stdout, stderr, env, ws } = await orchestrate(t, 'decompose-ok', ['--json', 'Audit the error handling']);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'completed');
  const pkg = out.orchestration;
  assert.equal(pkg.outcome, 'completed');
  assert.equal(pkg.planner.model, M2);
  assert.deepEqual(pkg.plan.subtasks.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(pkg.subtasks.map((s) => s.status), ['completed', 'completed', 'completed']);
  const planner = sessionPosts(env).find((r) => r.body.title.startsWith('OPC: orch-plan: '));
  assert.ok(planner, 'planner session created');
  assert.deepEqual(planner.body.permissions[0], DENY_ALL, 'planner runs read-only');
  assert.equal(readTurnLog(env).filter((e) => e.role === 'planner').length, 1);
  const stateDir = workspaceStateDir(env.OPC_DATA_DIR, resolveWorkspaceRoot(ws));
  const roles = listJobs(stateDir, { all: true }).filter((j) => j.groupId === out.jobId).map((j) => j.role).sort();
  assert.deepEqual(roles, ['planner', 'worker:1', 'worker:2', 'worker:3']);
});

test('F4b: decompose-cycle is rejected with the reason and the raw plan', async (t) => {
  const { code, stdout, env } = await orchestrate(t, 'decompose-cycle', ['--json', 'Plan with a cycle']);
  assert.equal(code, 7);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'failed');
  assert.equal(out.errorCode, 'invalid_plan');
  assert.match(out.orchestration.errorMessage, /ciclo de dependência: a -> b -> a/);
  assert.deepEqual(out.orchestration.rawPlan.subtasks.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(readTurnLog(env).map((e) => e.role), ['planner'], 'no subtask ran');
});

test('F4b: write subtask without --write is rejected', async (t) => {
  const { code, stdout, env } = await orchestrate(t, 'decompose-write-without-flag', ['--json', 'Edit two files']);
  assert.equal(code, 7);
  const out = JSON.parse(stdout);
  assert.equal(out.errorCode, 'invalid_plan');
  assert.match(out.orchestration.planErrors.join('\n'), /subtarefa "w1" tem kind "task" \(escreve arquivos\), mas a orquestração foi iniciada sem --write/);
  assert.equal(subtaskTurns(env).length, 0);
});

test('F4b: write subtasks run in series (non-overlapping windows); reads run in parallel', async (t) => {
  const { code, stdout, stderr, env } = await orchestrate(t, 'decompose-write-without-flag', ['--json', '--write', 'Edit two files']);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).orchestration.outcome, 'completed');
  const [w1, w2, r1, r2] = ['w1', 'w2', 'r1', 'r2'].map((id) => turnOf(env, id));
  assert.ok(w1 && w2 && r1 && r2, 'all four subtasks ran');
  assert.equal(overlaps(w1, w2), false, `write windows overlap: w1=[${w1.start},${w1.end}] w2=[${w2.start},${w2.end}]`);
  assert.equal(overlaps(r1, r2), true, 'read subtasks should overlap');
  const sessionOf = (id) => sessionPosts(env).find((r) => new RegExp(`^OPC: orch-\\w+: ${id}\\b`).test(r.body.title));
  const has = (session, action, effect) => session.body.permissions.some((r) => r.action === action && r.resource === '*' && r.effect === effect);
  const asksShell = (session) => session.body.permissions.some((r) => r.action === 'shell' && r.effect === 'ask');
  const w1Session = sessionOf('w1');
  const r1Session = sessionOf('r1');
  assert.ok(w1Session && r1Session, 'write and read subtask sessions were created');
  // write-only invariants (policy.mjs invariantRules): no blanket grep deny, destructive shell commands ask
  assert.equal(has(w1Session, 'grep', 'deny'), false, 'write subtask uses the write profile (grep allowed)');
  assert.equal(asksShell(w1Session), true, 'write subtask uses the write profile (destructive shell asks)');
  assert.notDeepEqual(w1Session.body.permissions[0], DENY_ALL, 'write subtask is not read-only');
  // read subtasks keep the read-only invariants
  assert.equal(has(r1Session, 'grep', 'deny'), true, 'read subtask denies grep');
  assert.equal(asksShell(r1Session), false, 'read subtask never asks for shell (blanket deny)');
  assert.deepEqual(r1Session.body.permissions[0], DENY_ALL, 'read subtask is read-only');
});

test('F4b: dependency results are injected into the dependent prompt', async (t) => {
  const { code, stderr, env } = await orchestrate(t, 'decompose-ok', ['--json', 'Audit the error handling']);
  assert.equal(code, 0, stderr);
  const a = turnOf(env, 'a');
  const b = turnOf(env, 'b');
  const c = turnOf(env, 'c');
  assert.deepEqual(c.dependencies, [
    { id: 'a', result: `RESULT[a] by ${modelID(M1)}` },
    { id: 'b', result: `RESULT[b] by ${modelID(M2)}` },
  ]);
  assert.deepEqual(a.dependencies, [], 'a subtask without dependencies receives no dependency block');
  assert.ok(c.start >= Math.max(a.end, b.end), 'dependent started after its dependencies finished');
});

test('F4b: failed subtask cancels dependents with dependency_failed; independents finish', async (t) => {
  const { code, stdout, stderr, env } = await orchestrate(t, 'subtask-fail', ['--json', 'Partial failure']);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'completed');
  assert.equal(out.orchestration.outcome, 'completed_with_warnings');
  const byId = Object.fromEntries(out.orchestration.subtasks.map((s) => [s.id, s]));
  assert.equal(byId.a.status, 'failed');
  assert.deepEqual([byId.b.status, byId.b.errorCode], ['cancelled', 'dependency_failed']);
  assert.equal(byId.c.status, 'completed');
  assert.equal(turnOf(env, 'b'), undefined, 'dependent never ran');
});

test('F4b: models are spread across subtasks', async (t) => {
  const { code, stderr, env } = await orchestrate(t, 'decompose-ok', ['--json', 'Audit the error handling']);
  assert.equal(code, 0, stderr);
  assert.deepEqual(['a', 'b', 'c'].map((id) => turnOf(env, id).model), [M1, M2, M3].map(modelID));
});

test('F4b: Claude synthesis returns the structured package without a synthesis session', async (t) => {
  const { code, stdout, stderr, env, ws } = await orchestrate(t, 'decompose-ok', ['--json', 'Audit the error handling']);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.orchestration.synthesis, { mode: 'claude', status: 'pending', model: null, text: null, errorMessage: null, attempts: [] });
  assert.deepEqual(sessionPosts(env).filter((r) => r.body.title.startsWith('OPC: orch-synth: ')), [], 'Claude synthesis creates no OpenCode synthesis session');
  assert.equal(readTurnLog(env).filter((e) => e.role === 'synthesizer').length, 0);
  const rendered = await runCli(['result', out.jobId], { env, cwd: ws });
  assert.match(rendered.stdout, /## Síntese\n\nSíntese a cargo do Claude/);
  assert.match(rendered.stdout, /RESULT\[a\] by /, 'raw results are delivered for Claude to synthesize');
});

test('F4b: model synthesis runs a read-only session with every result', async (t) => {
  const { code, stdout, stderr, env, ws } = await orchestrate(t, 'synth-ok', ['--json', '--synthesizer', M3, 'Answer A and B']);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  const synthesis = out.orchestration.synthesis;
  assert.deepEqual([synthesis.mode, synthesis.status, synthesis.model, synthesis.text], ['model', 'completed', M3, 'SYNTHESIS-OK: A and B agree']);
  const synthTurn = readTurnLog(env).find((e) => e.role === 'synthesizer');
  assert.equal(synthTurn.model, modelID(M3));
  assert.deepEqual(synthTurn.results.map(({ id, kind, status }) => [id, kind, status]), [['a', 'ask', 'completed'], ['b', 'ask', 'completed']]);
  assert.ok(synthTurn.results.every((r) => r.result.startsWith(`RESULT[${r.id}] by `)));
  const synthSession = sessionPosts(env).find((r) => r.body.title.startsWith('OPC: orch-synth: '));
  assert.deepEqual(synthSession.body.permissions[0], DENY_ALL, 'synthesizer runs read-only');
  const rendered = await runCli(['result', out.jobId], { env, cwd: ws });
  assert.match(rendered.stdout, /Sintetizador: `omniroute-personal\/opencode-go\/kimi-k3`\n\nSYNTHESIS-OK/);
  assert.match(rendered.stdout, /RESULT\[a\] by /, 'raw results are delivered with the synthesis');
  assert.match(rendered.stdout, /RESULT\[b\] by /, 'raw results are delivered with the synthesis');
});

test('F4b: a planner reply without a valid JSON plan fails the group (OpenCode 2 has no StructuredOutputError)', async (t) => {
  const { code, stdout, env } = await orchestrate(t, 'planner-structured-error', ['--json', 'Anything']);
  assert.equal(code, 7);
  const out = JSON.parse(stdout);
  assert.equal(out.errorCode, 'planner_failed');
  assert.match(out.orchestration.errorMessage, /nenhum plano estruturado foi retornado/);
  assert.match(out.orchestration.rawPlan, /Resposta fora do esquema JSON/);
  assert.equal(subtaskTurns(env).length, 0);
});
