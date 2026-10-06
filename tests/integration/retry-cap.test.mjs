import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig,
  jobsIn, promptModels, requestsTo, stateDirFor,
} from '../helpers.mjs';

function config(fallback) {
  return {
    defaultProvider: 'omniroute-personal',
    defaultModel: M.fast,
    routing: {
      tasks: { ask: [M.fast, M.k3] },
      tiers: { light: [M.fast], heavy: [M.strong, M.k3] },
      fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60, ...fallback },
    },
  };
}

const jobLog = (env, ws, job) => fs.readFileSync(path.join(stateDirFor(env, ws), 'jobs', `${job.id}.log`), 'utf8');

function setup(t, fallback, extra = {}) {
  const env = testEnv(t, { scenario: 'retry-over-cap', extra: { FAKE_FAIL_MODELS: M.fast, OPC_FALLBACK_BACKOFF_MS: '50', ...extra } });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, config(fallback));
  return { env, ws };
}

test('retry attempts above maxProviderRetries abort the session as RetryCapExceeded', async (t) => {
  const { env, ws } = setup(t, { maxProviderRetries: 2 });
  const started = performance.now();
  const r = await runCli(['ask', '--model', M.fast, 'Summarise the repository'], { env, cwd: ws });
  assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
  assert.ok(performance.now() - started < 30_000, 'turn must not hang on endless retries');
  const [job] = jobsIn(env, ws);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'retry_cap');
  assert.equal(job.errorType, 'RetryCapExceeded');
  assert.equal(job.errorClass, 'recoverable');
  assert.equal(job.errorMessage, 'Limite de novas tentativas excedido.');
  assert.match(jobLog(env, ws, job), /Nova tentativa \(3\)/, 'the third scheduled retry is the one above the cap');
  assert.equal(requestsTo(env, 'POST', /^\/api\/session\/[^/]+\/interrupt$/).length, 1);
  assert.deepEqual(promptModels(env), [M.fast], 'explicit --model: no fallback');
  assert.match(r.stderr, /Nova tentativa/);
});

test('a scheduled retry further away than maxRetryWaitSec aborts the session', async (t) => {
  const { env, ws } = setup(t, { maxProviderRetries: 20, maxRetryWaitSec: 1 });
  const r = await runCli(['ask', '--model', M.fast, 'Summarise the repository'], { env, cwd: ws });
  assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
  const [job] = jobsIn(env, ws);
  assert.equal(job.errorCode, 'retry_cap');
  assert.equal(job.errorType, 'RetryCapExceeded');
  assert.equal(job.errorMessage, 'Limite de novas tentativas excedido.');
  assert.match(jobLog(env, ws, job), /Nova tentativa \(2\)/, 'the second retry is scheduled further away than maxRetryWaitSec');
  assert.equal(requestsTo(env, 'POST', /^\/api\/session\/[^/]+\/interrupt$/).length, 1);
});

test('retries below the cap are left to OpenCode (no client abort)', async (t) => {
  const { env, ws } = setup(t, { maxProviderRetries: 20, maxRetryWaitSec: 3600 }, { FAKE_RETRY_MAX_TICKS: '5' });
  const r = await runCli(['ask', '--model', M.fast, 'Summarise the repository'], { env, cwd: ws });
  assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
  assert.equal(requestsTo(env, 'POST', /\/interrupt$/).length, 0);
  const [job] = jobsIn(env, ws);
  // OpenCode exhausts its own retries and ends the execution with the provider error.
  assert.equal(job.errorType, 'provider.transport');
  assert.equal(job.errorClass, 'recoverable');
});
