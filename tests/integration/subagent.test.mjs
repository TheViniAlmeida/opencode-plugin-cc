import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState, stateDirFor, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';
import { readJob, listGroupMembers } from '../../plugins/opc/scripts/lib/jobs.mjs';

async function setup(t, { scenario = 'group-slow', config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t); const env = testEnv(t, { scenario, extra }); writeGlobalConfig(env, config); return { cwd, env };
}
const created = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/session').map((r) => r.body);
const prompts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /\/prompt_async$/.test(r.path)).map((r) => r.body);
const DENY_ALL = { permission: '*', pattern: '*', action: 'deny' };

test('três membros: sessão própria, resultado e corpos corretos', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', '--json', 'Explique o repositório'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed'); assert.equal(group.role, 'group');
  assert.deepEqual(members.map((m) => m.model), [F3_MODELS.deepseek, F3_MODELS.qwen, F3_MODELS.kimi]);
  assert.deepEqual(members.map((m) => m.result.finalText), [
    'RESULT general opencode-go/deepseek-v4.1-flash', 'RESULT general opencode-go/qwen3.8-max', 'RESULT general opencode-go/kimi-k3',
  ]);
  assert.equal(new Set(members.map((m) => m.sessionID)).size, 3);
  const bodies = created(env); const parent = bodies.find((b) => !b.parentID);
  assert.match(parent.title, /^OPC: subagents:/); const children = bodies.filter((b) => b.parentID);
  assert.equal(children.length, 3); assert.ok(children.every((b) => b.parentID === group.sessionID && b.agent === 'general'));
  assert.ok(children.every((b) => b.permission[0].permission === DENY_ALL.permission));
  const sent = prompts(env);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((b) => b.agent === 'general' && b.parts[0].type === 'text' && b.parts[0].text === 'Explique o repositório'));
  assert.deepEqual(sent.map((b) => [b.model.providerID, b.model.modelID]).sort((a, b) => a[1].localeCompare(b[1])), [
    ['omniroute-personal', 'opencode-go/deepseek-v4.1-flash'],
    ['omniroute-personal', 'opencode-go/kimi-k3'],
    ['omniroute-personal', 'opencode-go/qwen3.8-max'],
  ]);
  const text = await runCli(['subagent', '--agent', 'general', '--model', 'fast', 'hello'], { env, cwd });
  assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, /# Resultado do grupo/);
});

test('prompt chega intacto a todos os membros', async (t) => {
  const { cwd, env } = await setup(t); const prompt = 'linha1\nlinha2 `tick` $(touch pwned) "q" ção 🚀';
  const res = await runCli(['subagent', '--raw-args-stdin'], { env, cwd, stdin: `--agent general --model fast,strong -- ${prompt}\n` });
  assert.equal(res.code, 0, res.stderr); assert.deepEqual(prompts(env).map((b) => b.parts[0].text), [prompt, prompt]);
  assert.equal(existsSync(join(cwd, 'pwned')), false);
});

test('recusa execução de dentro do servidor', async (t) => {
  const { cwd, env } = await setup(t); const res = await runCli(['subagent', '--agent', 'general', 'hi'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stdout + res.stderr); assert.equal(created(env).length, 0);
});

test('jobs.maxParallel limita turnos concorrentes', async (t) => {
  const { cwd, env } = await setup(t, { config: { ...F3_TEST_CONFIG, jobs: { maxActive: 8, maxParallel: 2 } }, extra: { FAKE_GROUP_DELAY_MS: '1500' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const at = readFakeState(env).f3.prompts.map((p) => p.at); const t0 = Math.min(...at);
  assert.equal(at.filter((x) => x - t0 < 750).length, 2); assert.equal(at.length, 3);
});

test('--write executa membros em série com as regras de escrita', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_DELAY_MS: '800' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'fast,strong', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const at = readFakeState(env).f3.prompts.map((p) => p.at);
  assert.ok(Math.max(...at) - Math.min(...at) >= 700);
  assert.ok(created(env).filter((b) => b.parentID).every((b) => b.permission[0].permission !== '*'));
});

test('recusas de política e uso ocorrem antes de criar sessão', async (t) => {
  const { cwd, env } = await setup(t);
  const cases = [
    [['subagent', '--agent', 'work-secret', 'hi'], 4], [['subagent', '--agent', 'pinned-sub', 'hi'], 4],
    [['subagent', '--agent', 'build', 'hi'], 2], [['subagent', '--agent', 'general', '--model', 'omniroute-work/cx/gpt-5.5', 'hi'], 4],
    [['subagent', '--agent', 'general,explore', '--model', 'fast,strong,k3', 'hi'], 2], [['subagent', 'hi'], 2],
    [['subagent', '--agent', 'general'], 2], [['subagent', '--agent', 'general', '--mechanism', 'magic', 'hi'], 2],
    [['subagent', '--agent', Array(9).fill('general').join(','), 'hi'], 2],
  ];
  for (const [args, code] of cases) { const res = await runCli(args, { env, cwd }); assert.equal(res.code, code, `${args[0]} → ${res.stdout}${res.stderr}`); }
  assert.equal(created(env).length, 0);
});

test('falha de um membro conclui grupo com avisos', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_FAIL_MODEL: 'kimi-k3' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong,k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed'); assert.deepEqual(members.map((m) => m.status), ['completed', 'completed', 'failed']);
  assert.deepEqual(group.result.warnings, ['1 failed, 0 cancelled']);
  const sd = await stateDirFor(env, cwd); assert.match(readJob(sd, group.id).rendered, /ProviderAuthError|invalid api key/);
});

test('--background retorna rápido e coordenador conclui grupo', async (t) => {
  const { cwd, env } = await setup(t); const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast,strong', '--background', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const { group } = JSON.parse(res.stdout); assert.ok(['queued', 'running'].includes(group.status));
  const sd = await stateDirFor(env, cwd); await eventually(() => readJob(sd, group.id)?.status === 'completed');
  assert.ok(listGroupMembers(sd, group.id).every((m) => m.status === 'completed' && m.pid === readJob(sd, group.id).pid));
});

test('usa subtask quando modo do agente é recusado', async (t) => {
  const { cwd, env } = await setup(t, { scenario: 'subagent-mode-refused' });
  const res = await runCli(['subagent', '--agent', 'explore', '--model', 'fast', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const [member] = JSON.parse(res.stdout).members;
  assert.equal(member.result.mechanism, 'subtask'); assert.equal(member.result.fellBack, true);
  assert.match(member.result.finalText, /^SUBTASK explore opencode-go\/deepseek-v4\.1-flash via ses_/);
  const sent = prompts(env); assert.equal(sent[0].agent, 'explore'); assert.equal(sent[1].parts[0].type, 'subtask');
});

test('--mechanism subtask ignora tentativa de sessão filha', async (t) => {
  const { cwd, env } = await setup(t); const res = await runCli(['subagent', '--agent', 'general', '--model', 'fast', '--mechanism', 'subtask', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stderr); const [member] = JSON.parse(res.stdout).members;
  assert.equal(member.result.mechanism, 'subtask'); assert.equal(member.result.fellBack, false);
  assert.equal(member.result.finalText, 'SUBTASK general opencode-go/deepseek-v4.1-flash'); assert.ok(created(env).every((b) => !b.agent));
});

test('pedido de permissão de membro pode ser respondido e grupo conclui', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'permission' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'fast,k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 3, res.stderr); const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'waiting_permission'); assert.equal(group.pendingRequest[0].memberId, members[1].id); assert.equal(members[1].status, 'waiting_permission');
  const reply = await runCli(['permissions', 'reply', 'per_f3_1', 'once'], { env, cwd }); assert.equal(reply.code, 0, reply.stdout + reply.stderr);
  const sd = await stateDirFor(env, cwd); await eventually(() => readJob(sd, group.id)?.status === 'completed');
  const completed = readJob(sd, group.id);
  assert.equal(completed.result.members[1].status, 'completed');
  assert.equal(listGroupMembers(sd, group.id)[1].result.finalText, 'AFTER REPLY');
  assert.match(completed.rendered, /AFTER REPLY/);
});

test('pergunta de membro pode ser respondida', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'question' } });
  const res = await runCli(['subagent', '--write', '--agent', 'general', '--model', 'k3', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 3, res.stderr); assert.equal(JSON.parse(res.stdout).group.pendingRequest[0].type, 'question');
  const answer = await runCli(['permissions', 'answer', 'que_f3_1', 'A'], { env, cwd }); assert.equal(answer.code, 0, answer.stdout + answer.stderr);
  const sd = await stateDirFor(env, cwd); await eventually(() => readJob(sd, JSON.parse(res.stdout).group.id)?.status === 'completed');
});

test('membros somente leitura recusam pedidos de permissão automaticamente', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_GROUP_ASK: 'permission' } });
  const res = await runCli(['subagent', '--agent', 'general', '--model', 'k3', '--json', 'p'], { env, cwd }); assert.equal(res.code, 0, res.stderr);
  const replies = fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/permission/per_f3_1/reply');
  assert.ok(replies.some((r) => r.body.reply === 'reject')); assert.ok(replies.every((r) => r.body.reply !== 'always'));
});
