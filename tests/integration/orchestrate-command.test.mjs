import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, readFakeState, writeGlobalConfig, waitFor, jobsIn, jobIn } from '../helpers.mjs';

const P = 'omniroute-personal/opencode-go/';
const M1 = `${P}deepseek-v4.1-flash`; const M2 = `${P}qwen3.8-max`; const M3 = `${P}kimi-k3`;
function orchestrateConfig(extra = {}) {
  const list = [M1, M2, M3];
  return { defaultProvider: 'omniroute-personal', defaultModel: M1, orchestrate: { planner: M2, maxSubtasks: 5, synthesizer: 'claude' }, routing: { tasks: { ask: list, plan: list, review: list, task: list }, tiers: { light: list, heavy: list }, fallback: { enabled: false, maxAttempts: 1, maxProviderRetries: 3, maxRetryWaitSec: 60 } }, jobs: { maxActive: 8, maxParallel: 4 }, ...extra };
}
function setup(t, scenario, config = orchestrateConfig()) { const ws = makeWorkspace(t); const env = testEnv(t, { scenario }); writeGlobalConfig(env, config); return { ws, env }; }
const sessionPosts = (env) => readFakeState(env).requests.filter((r) => r.method === 'POST' && r.path === '/api/session');

test('orchestrate sem tarefa é erro de uso', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); const { code, stdout, stderr } = await runCli(['orchestrate'], { env, cwd: ws }); assert.equal(code, 2); assert.match(stdout + stderr, /tarefa ausente/); });
test('--max fora de 2..10 é erro de uso', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); for (const max of ['1', '11']) { const { code } = await runCli(['orchestrate', '--max', max, 'tarefa'], { env, cwd: ws }); assert.equal(code, 2); } });
test('OPC_INSIDE_SERVER=1 recusa antes de criar sessão', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); const { code, stdout, stderr } = await runCli(['orchestrate', 'tarefa'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd: ws }); assert.equal(code, 4); assert.match(stdout + stderr, /OPC_INSIDE_SERVER=1/); assert.equal(sessionPosts(env).length, 0); });
test('--raw-args-stdin mantém tarefa literal e extrai flags', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); const { code, stdout, stderr } = await runCli(['orchestrate', '--json', '--raw-args-stdin'], { env, cwd: ws, timeoutMs: 120000, stdin: "--max 3 Don't break $& the error handling\n" }); assert.equal(code, 0, stderr); const out = JSON.parse(stdout); assert.equal(out.orchestration.task, "Don't break $& the error handling"); assert.equal(out.orchestration.maxSubtasks, 3); });
test('planner negado por política sai antes de criar sessão', async (t) => { const config = orchestrateConfig({ policy: { models: { allow: [], deny: ['*kimi*'] } } }); const { ws, env } = setup(t, 'decompose-ok', config); const { code } = await runCli(['orchestrate', '--planner', M3, 'tarefa'], { env, cwd: ws }); assert.equal(code, 4); assert.equal(sessionPosts(env).length, 0); });
test('foreground imprime relatório Markdown', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); const { code, stdout, stderr } = await runCli(['orchestrate', 'Audit the error handling'], { env, cwd: ws, timeoutMs: 120000 }); assert.equal(code, 0, stderr); assert.match(stdout, /^# opc orchestrate\n/); assert.match(stdout, /Status: concluída · job orch-/); assert.match(stdout, /## Resultados/); assert.match(stdout, /Síntese a cargo do Claude/); });
test('background devolve id; status e result acompanham o grupo', async (t) => { const { ws, env } = setup(t, 'decompose-ok'); const started = await runCli(['orchestrate', '--background', '--json', 'Audit the error handling'], { env, cwd: ws }); assert.equal(started.code, 0, started.stderr || started.stdout); const { jobId, background } = JSON.parse(started.stdout); assert.equal(background, true); assert.match(jobId, /^orch-/); const waited = await runCli(['status', jobId, '--wait', '--timeout-ms', '90000'], { env, cwd: ws, timeoutMs: 120000 }); assert.equal(waited.code, 0, waited.stderr); const result = await runCli(['result', jobId], { env, cwd: ws }); assert.equal(result.code, 0, result.stderr || result.stdout); assert.match(result.stdout, /# opc orchestrate/); assert.match(result.stdout, /### c — Review against policy/); const asJson = await runCli(['result', jobId, '--json'], { env, cwd: ws }); assert.equal(asJson.code, 0, asJson.stderr); const { group, members } = JSON.parse(asJson.stdout); assert.equal(group.role, 'group'); assert.equal(group.result.schemaVersion, 1); assert.match(group.rendered, /^# opc orchestrate\n/); assert.deepEqual(members.map((m) => m.role).sort(), ['planner', 'worker:1', 'worker:2', 'worker:3']); });

for (const mode of ['text', 'tool']) {
  test(`I4: fake planner completes using ${mode} output`, async (t) => {
    const config = orchestrateConfig(); config.orchestrate.structuredOutput = mode;
    const { ws, env } = setup(t, 'decompose-ok', config);
    const result = await runCli(['orchestrate', '--json', 'Audit'], { env, cwd: ws, timeoutMs: 120000 });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).orchestration.subtasks.length, 3);
    const request = readFakeState(env).requests.find((r) => r.method === 'POST' && /\/api\/session\/[^/]+\/prompt$/.test(r.path));
    assert.ok(request);
    assert.equal(Object.hasOwn(request.body, 'format'), false);
    assert.match(request.body.text, /Reply with only one JSON object/);
  });
}

test('C1: cancel group aborts an in-flight member and returns a cancelled group', async (t) => {
  const { ws, env } = setup(t, 'orchestrate-active');
  const started = await runCli(['orchestrate', '--background', '--json', 'Audit'], { env, cwd: ws });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const { jobId } = JSON.parse(started.stdout);
  // Observe the server, not the member metadata: this fails the original early-ID bug.
  const sessionID = await waitFor(() => {
    const state = readFakeState(env);
    return Object.values(state.sessions).find((s) => s.title.startsWith('OPC: orch-ask: ') && state.statuses?.[s.id]?.type === 'busy')?.id;
  }, { timeoutMs: 20000, message: 'active worker session' });
  const member = jobsIn(env, ws).find((m) => m.groupId === jobId && m.role.startsWith('worker:'));
  assert.ok(member?.attemptInFlight);
  assert.equal(member.attempts?.length ?? 0, 0);
  const cancelled = await runCli(['cancel', jobId, '--json'], { env, cwd: ws });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.deepEqual(JSON.parse(cancelled.stdout).failedMembers, []);
  assert.ok(readFakeState(env).aborts.includes(sessionID));
  assert.equal(jobIn(env, ws, jobId).status, 'cancelled');
  const result = await runCli(['result', jobId, '--json'], { env, cwd: ws });
  assert.equal(result.code, 130, result.stderr);
});

test('F4b fix2: cancel group during delayed POST /session prevents the write prompt and exits 130', async (t) => {
  const { ws, env } = setup(t, 'orchestrate-create-delayed');
  const started = await runCli(['orchestrate', '--background', '--write', '--json', 'Update a disposable file'], { env, cwd: ws });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const { jobId } = JSON.parse(started.stdout);
  await waitFor(() => readFakeState(env).delayedCreateStartedAt, { timeoutMs: 20000, message: 'delayed write session creation' });
  const member = jobsIn(env, ws).find((m) => m.groupId === jobId && m.role === 'worker:1');
  assert.equal(member.sessionID, null);
  assert.equal(member.attemptInFlight, true);
  const cancelled = await runCli(['cancel', jobId, '--json'], { env, cwd: ws });
  assert.equal(cancelled.code, 0, cancelled.stderr || cancelled.stdout);
  assert.deepEqual(JSON.parse(cancelled.stdout).failedMembers, []);
  assert.ok(jobIn(env, ws, jobId).cancelRequestedAt);
  assert.ok(jobIn(env, ws, member.id).cancelRequestedAt);
  const finalMember = await waitFor(() => {
    const value = jobIn(env, ws, member.id);
    return ['completed', 'failed', 'cancelled'].includes(value.status) && value;
  }, { timeoutMs: 20000, message: 'delayed member finalization' });
  assert.equal(finalMember.status, 'cancelled');
  assert.equal(finalMember.attempts[0].status, 'cancelled');
  const state = readFakeState(env);
  assert.ok(state.delayedCreateFinishedAt - state.delayedCreateStartedAt > 2000);
  const session = Object.values(state.sessions).find((s) => s.title.startsWith('OPC: orch-task:'));
  assert.ok(session, 'the delayed session was created');
  assert.equal(finalMember.sessionID, session.id);
  assert.equal(state.requests.filter((r) => r.method === 'POST' && r.path === `/session/${session.id}/prompt_async`).length, 0);
  assert.ok(state.aborts.includes(session.id));
  await waitFor(() => jobIn(env, ws, jobId).status === 'cancelled', { message: 'cancelled group' });
  const result = await runCli(['result', jobId, '--json'], { env, cwd: ws });
  assert.equal(result.code, 130, result.stderr || result.stdout);
});
