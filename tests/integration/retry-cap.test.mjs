import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig,
  jobsIn, promptModels, requestsTo,
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

function setup(t, fallback) {
  const env = testEnv(t, { scenario: 'retry-over-cap', extra: { FAKE_FAIL_MODELS: M.fast, OPC_FALLBACK_BACKOFF_MS: '50' } });
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
  assert.match(job.errorMessage ?? '', /tentativa 3/);
  assert.equal(requestsTo(env, 'POST', /^\/session\/[^/]+\/abort$/).length, 1);
  assert.deepEqual(promptModels(env), [M.fast], 'explicit --model: no fallback');
  assert.match(r.stderr, /Nova tentativa/);
});

test('a scheduled retry further away than maxRetryWaitSec aborts the session', async (t) => {
  const { env, ws } = setup(t, { maxProviderRetries: 99, maxRetryWaitSec: 1 });
  const r = await runCli(['ask', '--model', M.fast, 'Summarise the repository'], { env, cwd: ws });
  assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
  const [job] = jobsIn(env, ws);
  assert.equal(job.errorCode, 'retry_cap');
  assert.equal(job.errorType, 'RetryCapExceeded');
  assert.match(job.errorMessage ?? '', /tentativa 2/);
  assert.equal(requestsTo(env, 'POST', /^\/session\/[^/]+\/abort$/).length, 1);
});

test('retries below the cap are left to OpenCode (no client abort)', async (t) => {
  const { env, ws } = setup(t, { maxProviderRetries: 1000, maxRetryWaitSec: 3600 });
  const r = await runCli(['ask', '--model', M.fast, 'Summarise the repository'], { env, cwd: ws });
  assert.equal(r.code, 7, `${r.stdout}\n${r.stderr}`);
  assert.equal(requestsTo(env, 'POST', /\/abort$/).length, 0);
  const [job] = jobsIn(env, ws);
  assert.equal(job.errorType, 'MessageAbortedError');
  assert.equal(job.errorClass, 'fatal');
});
