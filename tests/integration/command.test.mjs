import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, readFakeState, eventually, stateDirFor } from '../helpers.mjs';
import { F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';
import { profileRules } from '../../plugins/opc/scripts/lib/context.mjs';

async function setup(t, { config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'command-sync', extra: { FAKE_COMMAND_DELAY_MS: '0', ...extra } });
  writeGlobalConfig(env, config);
  return { cwd, env };
}

const commandPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /^\/api\/session\/[^/]+\/command$/.test(r.path));
const sessionPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/api/session');
const DEFAULT_MODEL = { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' };
const QWEN_MODEL = { providerID: 'omniroute-personal', id: 'opencode-go/qwen3.8-max' };

// The fake masks free-form request fields (text), so the exact arguments are read from the user message
// that the fake stored for each command request ("/<name> <text>").
function commandInputs(env) {
  const state = readFakeState(env);
  return commandPosts(env).map((request) => {
    const sessionID = request.path.split('/')[3];
    const prefix = `/${request.body.name} `;
    const stored = (state.messages[sessionID] ?? []).findLast((message) => message.type === 'user' && message.text.startsWith(prefix));
    return { sessionID, name: request.body.name, text: stored?.text.slice(prefix.length), body: request.body };
  });
}

test('command sem argumentos: POST command {name, text}; modelo e regras vão na sessão somente leitura', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /COMANDO echo ARGUMENTOS\[\]/);
  const [input] = commandInputs(env);
  assert.deepEqual(Object.keys(input.body).sort(), ['name', 'text']);
  assert.equal(input.name, 'echo');
  assert.equal(input.text, '');
  const session = sessionPosts(env).at(-1).body;
  assert.deepEqual(session.model, DEFAULT_MODEL);
  assert.equal('agent' in session, false);
  assert.match(session.title, /^OPC: command: \/echo/);
  assert.deepEqual(session.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.equal(session.permission, undefined, 'V1 permission list is never sent');
  assert.match(readFakeState(env).sessions[input.sessionID].title, /^OPC: command: \/echo/);
});

test('command com argumentos, modelo alias e agente explícito; aceita barra inicial', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '/echo', 'hello', 'world', '--model', 'strong', '--agent', 'build', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const [input] = commandInputs(env);
  assert.deepEqual({ n: input.name, a: input.text }, { n: 'echo', a: 'hello world' });
  const session = sessionPosts(env).at(-1).body;
  assert.deepEqual({ m: session.model, g: session.agent }, { m: QWEN_MODEL, g: 'build' });
  const { job } = JSON.parse(res.stdout);
  assert.equal(job.kind, 'cmd');
  assert.match(job.id, /^cmd-/);
  assert.equal(job.result.finalText, 'COMANDO echo ARGUMENTOS[hello world]');
});

test('modelo/agente fixados passam pela política; comando desconhecido lista os disponíveis', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['command', 'pinned-model'], { env, cwd })).code, 4);
  assert.equal((await runCli(['command', 'pinned-agent'], { env, cwd })).code, 4);
  const unknown = await runCli(['command', 'nope'], { env, cwd });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout + unknown.stderr, /echo/);
  assert.equal((await runCli(['command'], { env, cwd })).code, 2);
  assert.equal(commandPosts(env).length, 0);
  assert.equal(sessionPosts(env).length, 0);
});

test('command fixado a subagente cria a sessão com o agente fixado', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'sub-echo', 'x'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(sessionPosts(env).at(-1).body.agent, 'general');
  assert.deepEqual(Object.keys(commandPosts(env)[0].body).sort(), ['name', 'text']);
});

test('command com turno maior que requestTimeoutSec conclui: o 204 volta logo e o resultado vem pelo turno', async (t) => {
  const config = { ...F3_TEST_CONFIG, server: { bootTimeoutSec: 60, requestTimeoutSec: 1, configOverride: { share: 'disabled' } } };
  const { cwd, env } = await setup(t, { config, extra: { FAKE_COMMAND_DELAY_MS: '2500' } });
  const res = await runCli(['command', 'echo', 'slow'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /COMANDO echo ARGUMENTOS\[slow\]/);
});

test('--background devolve id do job; result imprime a saída renderizada', async (t) => {
  const { cwd, env } = await setup(t);
  const bg = await runCli(['command', 'echo', 'bg', '--background', '--json'], { env, cwd });
  assert.equal(bg.code, 0, bg.stderr);
  const { job } = JSON.parse(bg.stdout);
  const result = await eventually(async () => {
    const r = await runCli(['result', job.id], { env, cwd });
    return r.code === 0 ? r : null;
  });
  assert.match(result.stdout, /# opc command \/echo/);
  assert.match(result.stdout, /COMANDO echo ARGUMENTOS\[bg\]/);
});

test('erro do assistente na resposta do command falha o job (exit 7)', async (t) => {
  const { cwd, env } = await setup(t, { extra: { FAKE_COMMAND_ERROR: '1' } });
  const res = await runCli(['command', 'echo'], { env, cwd });
  assert.equal(res.code, 7);
  assert.match(res.stdout, /Erro: ProviderAuthError/);
});

test('--write cria sessão com regras de escrita', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['command', 'echo', '--write'], { env, cwd })).code, 0);
  const rules = sessionPosts(env).at(-1).body.permissions;
  assert.deepEqual(rules, profileRules({ config: F3_TEST_CONFIG }, 'write'));
  assert.ok(rules.some((rule) => rule.action === 'shell' && rule.resource === 'git reset --hard*' && rule.effect === 'ask'));
  assert.ok(!rules.some((rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny'));
});

test('--raw-args-stdin preserva nome e argumentos e extrai flags', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '--raw-args-stdin'], { env, cwd, stdin: `echo it's "$(x)" --model strong\n` });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const [input] = commandInputs(env);
  assert.deepEqual({ c: input.name, a: input.text, m: sessionPosts(env).at(-1).body.model }, { c: 'echo', a: `it's "$(x)"`, m: QWEN_MODEL });
});

test('--raw-args-stdin preserva espaços dos argumentos byte por byte', async (t) => {
  const { cwd, env } = await setup(t);
  const args = '  leading  internal   trailing  ';
  const res = await runCli(['command', '--raw-args-stdin'], { env, cwd, stdin: `\n  echo ${args}\n` });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(commandInputs(env)[0].text, args);
});

test('argumentos secretos aparecem mascarados em disco e saída, mas chegam crus ao fake', async (t) => {
  const { cwd, env } = await setup(t);
  assert.equal((await runCli(['command', 'echo'], { env, cwd })).code, 0);
  const secret = JSON.parse(readFileSync(join(stateDirFor(env, cwd), 'server.json'), 'utf8')).password;
  const token = ['sk', 'proj', Math.random().toString(36).slice(2).padEnd(12, 'x')].join('-');
  const args = `${secret} ${token}`;
  const bg = await runCli(['command', '--raw-args-stdin', '--background', '--json'], { env, cwd, stdin: `echo ${args}\n` });
  assert.equal(bg.code, 0, bg.stdout + bg.stderr);
  const { job } = JSON.parse(bg.stdout);
  const result = await eventually(async () => {
    const result = await runCli(['result', job.id], { env, cwd });
    return result.code === 0 ? result : null;
  });
  const text = readFileSync(join(stateDirFor(env, cwd), 'jobs', `${job.id}.json`), 'utf8');
  const logPath = join(stateDirFor(env, cwd), 'jobs', `${job.id}.log`);
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const persistedJob = JSON.parse(text);
  assert.equal(Object.hasOwn(persistedJob.request, 'arguments'), false);
  assert.equal(Object.hasOwn(persistedJob.result, 'arguments'), false);
  assert.ok(persistedJob.request.argumentsPreview.length <= 200);
  assert.equal(persistedJob.request.argumentsBytes, Buffer.byteLength(args));
  for (const output of [text, bg.stdout, result.stdout, log]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(token));
  }
  assert.match(bg.stdout, /argumentsPreview/);
  assert.match(bg.stdout, /argumentsBytes/);
  assert.equal(commandInputs(env).at(-1).text, args);
});

test('recusa iniciar de dentro do servidor OpenCode (exit 4, nada enviado)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stdout + res.stderr);
  assert.equal(sessionPosts(env).length, 0);
  assert.equal(commandPosts(env).length, 0);
});
