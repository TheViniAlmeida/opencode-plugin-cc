import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig, jobsIn,
} from '../helpers.mjs';

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
