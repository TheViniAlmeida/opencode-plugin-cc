import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig, jobsIn, promptModels, requestsTo, waitFor } from '../helpers.mjs';

function config({ fallback = {}, tasks = {} } = {}) {
  return { defaultProvider: 'omniroute-personal', defaultModel: M.fast, reviewModel: null,
    routing: { tasks: { ask: [M.fast, M.k3], plan: [M.strong, M.k3], review: [M.strong, M.k3], task: [M.fast, M.strong], ...tasks },
      tiers: { light: [M.fast], heavy: [M.strong, M.k3] },
      fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60, ...fallback } } };
}
function setup(t, scenario, { extra = {}, cfg = config() } = {}) {
  const env = testEnv(t, { scenario, extra: { OPC_FALLBACK_BACKOFF_MS: '50', ...extra } });
  const ws = makeWorkspace(t); writeGlobalConfig(env, cfg); return { env, ws };
}
const sessionCreates = (env) => requestsTo(env, 'POST', /^\/session$/).length;
const output = (r) => `${r.stdout}\n${r.stderr}`;

test('model-429 faz fallback e registra tentativas', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r)); assert.deepEqual(promptModels(env), [M.fast, M.k3]); assert.equal(sessionCreates(env), 2);
  const [job] = jobsIn(env, ws); assert.equal(job.status, 'completed'); assert.equal(job.model, M.k3); assert.equal(job.attemptLimit, 2);
  assert.equal(job.attempts.length, 2); assert.notEqual(job.attempts[0].sessionID, job.attempts[1].sessionID);
  assert.equal(job.sessionID, job.attempts[1].sessionID); assert.match(r.stderr, /fallback/);
});

test('limite de retries do provedor aborta sessão e faz fallback', async (t) => {
  const { env, ws } = setup(t, 'retry-over-cap', { extra: { FAKE_FAIL_MODELS: M.fast }, cfg: config({ fallback: { maxProviderRetries: 2 } }) });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r)); assert.deepEqual(promptModels(env), [M.fast, M.k3]);
  assert.equal(requestsTo(env, 'POST', /^\/session\/[^/]+\/abort$/).length, 1);
  const [job] = jobsIn(env, ws); assert.equal(job.attempts[0].errorType, 'RetryCapExceeded'); assert.equal(job.attempts[1].status, 'completed');
});

test('falha fatal não faz fallback', async (t) => {
  const { env, ws } = setup(t, 'model-fatal', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast]);
  const [job] = jobsIn(env, ws); assert.equal(job.errorType, 'ProviderAuthError'); assert.equal(job.attempts.length, 1);
});

test('falha após escrita não faz fallback e lista arquivos e ferramentas', async (t) => {
  const { env, ws } = setup(t, 'write-then-fail', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['task', '--write', 'Adicione comentário a src/app.js'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast]);
  const [job] = jobsIn(env, ws); assert.equal(job.errorCode, 'WRITE_NO_FALLBACK');
  assert.match(job.errorMessage, /src\/app\.js/); assert.match(job.errorMessage, /edit/); assert.match(output(r), /src\/app\.js/);
});

test('modelo explícito desativa fallback', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['ask', '--model', M.fast, 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast]);
  const [job] = jobsIn(env, ws); assert.equal(job.attemptLimit, 1); assert.equal(job.attempts.length, 1);
});

test('fallback desativado não tenta outro modelo', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast }, cfg: config({ fallback: { enabled: false } }) });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast]);
});

test('falha recuperável de todos candidatos termina com FALLBACK_EXHAUSTED', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: `${M.fast},${M.k3}` } });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast, M.k3]);
  const [job] = jobsIn(env, ws); assert.equal(job.errorCode, 'FALLBACK_EXHAUSTED');
  assert.match(job.errorMessage, /1\) .*deepseek-v4\.1-flash: APIError; 2\) .*kimi-k3: APIError/);
});

test('retomada não faz fallback', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const first = await runCli(['ask', '--model', M.k3, 'Primeira pergunta'], { env, cwd: ws }); assert.equal(first.code, 0, output(first));
  const [firstJob] = jobsIn(env, ws); const second = await runCli(['ask', '--resume', firstJob.id, 'Pergunta seguinte'], { env, cwd: ws });
  assert.equal(second.code, 7, output(second)); assert.deepEqual(promptModels(env), [M.k3, M.fast]); assert.equal(sessionCreates(env), 1);
  const resumed = jobsIn(env, ws).find((j) => j.id !== firstJob.id); assert.equal(resumed.sessionID, firstJob.sessionID);
  assert.equal(resumed.attempts.length, 1); assert.equal(resumed.attemptLimit, 1);
});

test('cancelar durante espera de fallback não cria outra sessão', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast, OPC_FALLBACK_BACKOFF_MS: '30000' } });
  const r = await runCli(['ask', '--background', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws }); assert.equal(r.code, 0, output(r));
  const job = await waitFor(() => jobsIn(env, ws).find((j) => j.phase === 'fallback'), { timeoutMs: 20_000 });
  const c = await runCli(['cancel', job.id], { env, cwd: ws }); assert.equal(c.code, 0, output(c));
  await waitFor(() => jobsIn(env, ws).find((j) => j.id === job.id && j.status === 'cancelled'), { timeoutMs: 20_000 });
  await delay(500); assert.deepEqual(promptModels(env), [M.fast]); assert.equal(sessionCreates(env), 1);
});
