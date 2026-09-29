import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

async function setup(t, { config = F3_TEST_CONFIG, extra = {} } = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'command-sync', extra: { FAKE_COMMAND_DELAY_MS: '0', ...extra } });
  writeGlobalConfig(env, config);
  return { cwd, env };
}

const commandPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /^\/session\/[^/]+\/command$/.test(r.path));
const sessionPosts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && r.path === '/session');

test('command sem argumentos usa string provider/model e sessão somente leitura', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /COMMAND echo ARGS\[\]/);
  const [post] = commandPosts(env);
  assert.equal(post.body.command, 'echo');
  assert.equal(post.body.arguments, '');
  assert.equal(post.body.model, F3_MODELS.deepseek);
  assert.equal(typeof post.body.model, 'string');
  assert.match(post.body.messageID, /^msg/);
  assert.equal('agent' in post.body, false);
  const session = sessionPosts(env).at(-1).body;
  assert.match(session.title, /^OPC: command: \/echo/);
  assert.deepEqual(session.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('command com argumentos, modelo alias e agente explícito; aceita barra inicial', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '/echo', 'hello', 'world', '--model', 'strong', '--agent', 'build', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const [post] = commandPosts(env);
  assert.deepEqual({ a: post.body.arguments, m: post.body.model, g: post.body.agent }, { a: 'hello world', m: F3_MODELS.qwen, g: 'build' });
  const { job } = JSON.parse(res.stdout);
  assert.equal(job.kind, 'cmd');
  assert.match(job.id, /^cmd-/);
  assert.equal(job.result.finalText, 'COMMAND echo ARGS[hello world]');
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

test('command fixado a subagente envia o agente fixado', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'sub-echo', 'x'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(commandPosts(env)[0].body.agent, 'general');
});

test('command síncrono maior que requestTimeoutSec conclui com timeout longo', async (t) => {
  const config = { ...F3_TEST_CONFIG, server: { bootTimeoutSec: 60, requestTimeoutSec: 1, configOverride: { share: 'disabled' } } };
  const { cwd, env } = await setup(t, { config, extra: { FAKE_COMMAND_DELAY_MS: '2500' } });
  const res = await runCli(['command', 'echo', 'slow'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /COMMAND echo ARGS\[slow\]/);
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
  assert.match(result.stdout, /COMMAND echo ARGS\[bg\]/);
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
  assert.notDeepEqual(sessionPosts(env).at(-1).body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('--raw-args-stdin preserva nome e argumentos e extrai flags', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', '--raw-args-stdin'], { env, cwd, stdin: `echo it's "$(x)" --model strong\n` });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const [post] = commandPosts(env);
  assert.deepEqual({ c: post.body.command, a: post.body.arguments, m: post.body.model }, { c: 'echo', a: `it's "$(x)"`, m: F3_MODELS.qwen });
});

test('recusa iniciar de dentro do servidor OpenCode (exit 4, nada enviado)', async (t) => {
  const { cwd, env } = await setup(t);
  const res = await runCli(['command', 'echo'], { env: { ...env, OPC_INSIDE_SERVER: '1' }, cwd });
  assert.equal(res.code, 4, res.stdout + res.stderr);
  assert.equal(sessionPosts(env).length, 0);
  assert.equal(commandPosts(env).length, 0);
});
