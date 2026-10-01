import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cliJson, findJobId, makeWorkspace, testEnv, writeGlobalConfig, F2A_PROVIDER, F2A_MODEL, F2A_POLICY, FIXTURE_MODELS } from '../helpers.mjs';

const UNKNOWN_FLAG = /unknown (flag|option)|flag desconhecida|opção desconhecida/i;

function configuredEnv(t, { scenario = 'ok' } = {}) {
  const env = testEnv(t, { scenario });
  writeGlobalConfig(env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY });
  return env;
}

test('task, ask and plan accept --background, --wait-timeout and a "--" terminated prompt', async (t) => {
  const env = configuredEnv(t);
  const ws = makeWorkspace(t);
  for (const sub of ['task', 'ask', 'plan']) {
    const background = await cliJson([sub, '--background', '--', '--not-a-flag prompt'], { env, cwd: ws });
    assert.equal(background.code, 0, `${sub} --background: ${background.stderr}`);
    assert.ok(findJobId(background.data, sub), `${sub} returns a ${sub} job id`);
    const foreground = await cliJson([sub, '--wait-timeout', '60', '--', 'say ok'], { env, cwd: ws });
    assert.equal(foreground.code, 0, `${sub} --wait-timeout: ${foreground.stderr}`);
  }
});

test('subagent, orchestrate and conclave accept --background and --wait-timeout', async (t) => {
  const ws = makeWorkspace(t);
  for (const [head, scenario] of [
    [['subagent', '--agent', 'general'], 'ok'],
    [['orchestrate'], 'ok'],
    [['conclave', '--models', `${FIXTURE_MODELS.fast},${FIXTURE_MODELS.strong}`], 'conclave-opinion'],
  ]) {
    const env = configuredEnv(t, { scenario });
    for (const mode of [['--background'], ['--wait-timeout', '1']]) {
      const r = await cliJson([...head, ...mode, '--', 'x'], { env, cwd: ws });
      assert.equal(r.code, 0, `${head[0]} ${mode[0]} exits successfully: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, UNKNOWN_FLAG, `${head[0]} ${mode[0]}: ${r.stderr}`);
    }
  }
});
