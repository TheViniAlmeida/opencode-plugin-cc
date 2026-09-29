import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig, jobsIn,
} from '../helpers.mjs';
import { makeMainRepo, writeFile } from '../f2b-helpers.mjs';

test('result and foreground output show the attempts after a fallback', async (t) => {
  const env = testEnv(t, { scenario: 'model-429', extra: { FAKE_FAIL_MODELS: M.fast, OPC_FALLBACK_BACKOFF_MS: '50' } });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, {
    defaultProvider: 'omniroute-personal',
    defaultModel: M.fast,
    routing: { tasks: { ask: [M.fast, M.k3] }, tiers: { light: [M.fast], heavy: [M.k3] }, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } },
  });
  const fg = await runCli(['ask', 'Which file defines the entry point?'], { env, cwd: ws });
  assert.equal(fg.code, 0, fg.stderr);
  assert.match(fg.stdout, /## Tentativas \(2\)/);
  const [job] = jobsIn(env, ws);
  const res = await runCli(['result', job.id], { env, cwd: ws });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /## Tentativas \(2\)/);
  assert.ok(res.stdout.includes(M.fast) && res.stdout.includes(M.k3));
});

test('no attempts section without fallback', async (t) => {
  const env = testEnv(t, { scenario: 'ok' });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, { defaultProvider: 'omniroute-personal', defaultModel: M.fast });
  const fg = await runCli(['ask', 'Which file defines the entry point?'], { env, cwd: ws });
  assert.equal(fg.code, 0, fg.stderr);
  assert.doesNotMatch(fg.stdout, /Tentativas/);
});

test('review text outputs show fallback attempts while JSON rendered stays unchanged', async (t) => {
  const env = testEnv(t, { scenario: 'model-429', extra: { FAKE_FAIL_MODELS: M.fast, OPC_FALLBACK_BACKOFF_MS: '50' } });
  const cwd = makeMainRepo(t);
  writeFile(cwd, 'src/attempt-review.js', "export const marker = 'REVIEW_ATTEMPT_MARKER';\n");
  writeGlobalConfig(env, {
    defaultProvider: 'omniroute-personal',
    defaultModel: M.fast,
    routing: { tasks: { review: [M.fast, M.k3] }, tiers: { light: [M.fast], heavy: [M.k3] }, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } },
  });

  const foreground = await runCli(['review', '--wait'], { env, cwd });
  assert.equal(foreground.code, 0, foreground.stderr);
  assert.match(foreground.stdout, /## Tentativas \(2\)/);
  const [job] = jobsIn(env, cwd).filter((item) => item.kind === 'review');
  assert.ok(job, 'review job should be recorded');

  const result = await runCli(['result', job.id], { env, cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /## Tentativas \(2\)/);
  assert.ok(result.stdout.includes(M.fast) && result.stdout.includes(M.k3));

  const foregroundJson = await runCli(['review', '--wait', '--json'], { env, cwd });
  assert.equal(foregroundJson.code, 0, foregroundJson.stderr);
  assert.doesNotMatch(JSON.parse(foregroundJson.stdout).rendered, /## Tentativas/);
  assert.doesNotMatch(foregroundJson.stdout, /## Tentativas/);

  const resultJson = await runCli(['result', job.id, '--json'], { env, cwd });
  assert.equal(resultJson.code, 0, resultJson.stderr);
  assert.doesNotMatch(JSON.parse(resultJson.stdout).rendered, /## Tentativas/);
  assert.doesNotMatch(resultJson.stdout, /## Tentativas/);
});
