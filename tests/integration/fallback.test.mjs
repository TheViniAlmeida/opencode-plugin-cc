import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig, jobsIn, promptModels, requestsTo, waitFor, stateDirFor } from '../helpers.mjs';
import { createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { runWithFallback } from '../../plugins/opc/scripts/lib/routing.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { memoryV2 } from '../unit/_memory-v2.mjs';

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
const sessionCreates = (env) => requestsTo(env, 'POST', /^\/api\/session$/).length;
const output = (r) => `${r.stdout}\n${r.stderr}`;

for (const failure of ['retry-cap', 'session-error', 'idle-error']) {
  for (const childBusy of [false, true]) {
    test(`write fallback confirms the parent and child after ${failure} (child busy: ${childBusy})`, async () => {
      const { api, hub, emit } = memoryV2();
      const stopped = new Set();
      let turns = 0;
      api.sessionStatus = async () => Object.fromEntries(['ses_mem1', 'ses_child']
        .filter((id) => !stopped.has(id)).map((id) => [id, { type: 'busy' }]));
      api.interrupt = async (id) => {
        api.calls.push(['interrupt', id]);
        if (id !== 'ses_child' || !childBusy) stopped.add(id);
        return false;
      };
      const result = await runWithFallback({
        candidates: [{ providerID: 'p', modelID: 'first', full: 'p/first' }, { providerID: 'p', modelID: 'second', full: 'p/second' }],
        fallbackEligible: true, fallbackCfg: { enabled: true, maxAttempts: 2 }, write: true, backoffMs: 0,
        runAttempt: async (model) => {
          turns++;
          if (turns > 1) return { status: 'completed', sessionID: 'ses_second', toolsRan: false };
          const pending = runTurn({ api, hub, request: { model, newSession: { permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
            parts: [{ type: 'text', text: 'hi' }], timeoutMs: 2000, idleWaitMs: 50, fallbackCfg: { maxProviderRetries: 1 } } });
          await api.promptSettled;
          emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_mem1' } });
          const error = { type: 'provider.transport', message: 'synthetic transport error' };
          api.messagesFor('ses_mem1', [{ id: api.lastPromptId(), type: 'user' },
            ...(failure === 'idle-error' ? [{ id: 'msg_error', type: 'assistant', error }] : [])]);
          if (failure === 'retry-cap') emit({ type: 'session.retry.scheduled', data: { sessionID: 'ses_mem1', attempt: 2, at: Date.now() + 1000, error } });
          else emit({ type: failure === 'idle-error' ? 'session.execution.succeeded' : 'session.execution.failed', data: { sessionID: 'ses_mem1', error } });
          return pending;
        },
      });
      assert.deepEqual(api.calls.filter(([name]) => name === 'interrupt').map(([, id]) => id), ['ses_mem1', 'ses_child']);
      assert.equal(turns, childBusy ? 1 : 2);
      assert.equal(result.attempts.length, childBusy ? 1 : 2);
      if (childBusy) {
        assert.equal(result.stopReason, 'fatal');
        assert.equal(result.result.errorCode, 'ABORT_UNCONFIRMED');
        assert.equal(result.result.errorClass, 'fatal');
        assert.equal(result.result.abortConfirmed, false);
      } else {
        assert.equal(result.result.status, 'completed');
      }
    });
  }
}

test('model-429 faz fallback e registra tentativas', async (t) => {
  const { env, ws } = setup(t, 'model-429', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r)); assert.deepEqual(promptModels(env), [M.fast, M.k3]); assert.equal(sessionCreates(env), 2);
  const [job] = jobsIn(env, ws); assert.equal(job.status, 'completed'); assert.equal(job.model, M.k3); assert.equal(job.attemptLimit, 2);
  assert.deepEqual(job.attempts.map(({ status, errorClass, errorType }) => ({ status, errorClass, errorType })), [
    { status: 'failed', errorClass: 'recoverable', errorType: 'provider.rate-limit' },
    { status: 'completed', errorClass: null, errorType: null },
  ]);
  assert.equal(job.attempts.length, 2); assert.notEqual(job.attempts[0].sessionID, job.attempts[1].sessionID);
  assert.equal(job.sessionID, job.attempts[1].sessionID); assert.match(r.stderr, /fallback/);
});

test('limite de retries do provedor aborta sessão e faz fallback', async (t) => {
  const { env, ws } = setup(t, 'retry-over-cap', { extra: { FAKE_FAIL_MODELS: M.fast }, cfg: config({ fallback: { maxProviderRetries: 2 } }) });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r)); assert.deepEqual(promptModels(env), [M.fast, M.k3]);
  assert.equal(requestsTo(env, 'POST', /^\/api\/session\/[^/]+\/interrupt$/).length, 1);
  const [job] = jobsIn(env, ws); assert.equal(job.attempts[0].errorType, 'RetryCapExceeded'); assert.equal(job.attempts[1].status, 'completed');
});

test('falha fatal não faz fallback', async (t) => {
  const { env, ws } = setup(t, 'model-fatal', { extra: { FAKE_FAIL_MODELS: M.fast } });
  const r = await runCli(['ask', 'Qual arquivo define o ponto de entrada?'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r)); assert.deepEqual(promptModels(env), [M.fast]);
  const [job] = jobsIn(env, ws); assert.equal(job.errorType, 'provider.auth'); assert.equal(job.attempts.length, 1);
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
  assert.match(job.errorMessage, /1\) .*deepseek-v4\.1-flash: provider\.rate-limit; 2\) .*kimi-k3: provider\.rate-limit/);
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
  // The fallback stop must not overwrite the cancellation's error fields.
  assert.equal(jobsIn(env, ws).find((j) => j.id === job.id).errorCode, 'cancelled');
});

test('mascara texto de erro da tentativa em todos os canais de saída do CLI', async (t) => {
  const secretLike = ['sk', 'proj', Math.random().toString(36).slice(2, 14)].join('-');
  const { env, ws } = setup(t, 'secret-error', { extra: { FAKE_ERROR_TEXT: secretLike } });
  const foreground = await runCli(['ask', 'Teste de erro mascarado'], { env, cwd: ws });
  assert.equal(foreground.code, 7, output(foreground));
  const [job] = jobsIn(env, ws);
  const result = await runCli(['result', job.id, '--json'], { env, cwd: ws });
  const status = await runCli(['status', job.id, '--json'], { env, cwd: ws });
  const persisted = fs.readFileSync(path.join(stateDirFor(env, ws), 'jobs', `${job.id}.json`), 'utf8');
  const log = fs.readFileSync(path.join(stateDirFor(env, ws), 'jobs', `${job.id}.log`), 'utf8');
  for (const [label, content] of [
    ['job JSON', persisted], ['job log', log], ['result JSON stdout', result.stdout],
    ['status JSON stdout', status.stdout], ['foreground stdout/stderr', output(foreground)],
  ]) {
    assert.ok(!content.includes(secretLike), `${label} leaked runtime secret-like value`);
    assert.ok(content.includes('***'), `${label} should show the redaction marker`);
  }
});

test('worker encerra como cancelled com cancelamento anterior à primeira tentativa', async (t) => {
  const { env, ws } = setup(t, 'model-429');
  const stateDir = stateDirFor(env, ws);
  const request = {
    kind: 'ask', profileKind: 'read-only', newSession: { title: 'opc ask: cancelamento prévio', permission: [] },
    childPermission: null, parts: [{ type: 'text', text: 'não deve ser enviado' }],
    model: { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash' },
    agent: null, variant: null, format: null, messageID: 'msg_pre_cancel', timeoutMs: 5000,
    fallbackCfg: config().routing.fallback,
    candidates: [
      { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash', full: M.fast },
      { providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: M.k3 },
    ], fallbackEligible: true,
  };
  const job = await createJob(stateDir, {
    kind: 'ask', title: 'opc ask: cancelamento prévio', workspaceRoot: ws,
    model: M.fast, permissionProfile: 'read-only', request,
  });
  await updateJob(stateDir, job.id, { cancelRequestedAt: new Date().toISOString() });
  const worker = await runCli(['task-worker', '--job-id', job.id], { env, cwd: ws, timeoutMs: 30000 });
  assert.equal(worker.code, 130, output(worker));
  const terminal = jobsIn(env, ws).find((entry) => entry.id === job.id);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.errorCode, 'cancelled');
  assert.deepEqual(terminal.attempts, []);
  assert.equal(requestsTo(env, 'POST', /^\/api\/session\/[^/]+\/prompt$/).length, 0);
});

for (const mode of ['interrupt-failed', 'busy']) {
  test(`fallback stops on a timeout with AbortUnconfirmed (${mode})`, async () => {
    const { api, hub } = memoryV2();
    let turns = 0;
    api.interrupt = async () => {
      if (mode === 'interrupt-failed') throw new RequestError('SERVER_ERROR', 'interrupt failed');
      return true;
    };
    const result = await runWithFallback({
      candidates: [
        { providerID: 'p', modelID: 'first', full: 'p/first' },
        { providerID: 'p', modelID: 'second', full: 'p/second' },
      ], fallbackEligible: true, fallbackCfg: { enabled: true, maxAttempts: 2 }, backoffMs: 0,
      runAttempt: async (model) => {
        turns++;
        return runTurn({ api, hub, request: { model, newSession: { permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
          parts: [{ type: 'text', text: 'hi' }], timeoutMs: 50, idleWaitMs: 100 } });
      },
    });
    assert.equal(result.attempts.length, 1);
    assert.equal(turns, 1);
    assert.equal(api.promptCalls.length, 1);
    assert.equal(result.stopReason, 'fatal');
    assert.equal(result.result.errorType, 'AbortUnconfirmed');
    assert.equal(result.result.errorClass, 'fatal');
  });
}
