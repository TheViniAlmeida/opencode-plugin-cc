import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli, testEnv, writeWorkspaceConfig } from '../helpers.mjs';
import { fixtureModelIds, makeMainRepo, serverAlive, stateDirFor, writeFile, writeGlobalConfig } from '../f2b-helpers.mjs';

function setup(t, { scenario = 'ok', config = null, extra = {} } = {}) {
  const cwd = makeMainRepo(t);
  const env = testEnv(t, { scenario, extra });
  if (config) writeGlobalConfig(env, config);
  return { cwd, env };
}

const readGlobal = (env) => JSON.parse(fs.readFileSync(path.join(env.OPC_DATA_DIR, 'config.json'), 'utf8'));

test('--enable-review-gate without a global config is refused', async (t) => {
  const { cwd, env } = setup(t);
  const result = await runCli(['setup', '--enable-review-gate', '--json'], { env, cwd });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Execute o onboarding/);
  assert.equal(fs.existsSync(path.join(env.OPC_DATA_DIR, 'config.json')), false);
});

test('--enable-review-gate and --disable-review-gate toggle stopGate.enabled', async (t) => {
  const { cwd, env } = setup(t, { config: { defaultModel: fixtureModelIds()[0] }, extra: { OPC_SERVER_URL: 'http://127.0.0.1:9' } });
  const enabled = await runCli(['setup', '--enable-review-gate', '--stop-server', '--json'], { env, cwd });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout).reviewGate, { enabled: true, changed: true });
  assert.equal(readGlobal(env).stopGate.enabled, true);

  const text = await runCli(['setup', '--stop-server'], { env, cwd });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Gate de parada: ativado/);

  const disabled = await runCli(['setup', '--disable-review-gate', '--stop-server'], { env, cwd });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.match(disabled.stdout, /Gate de parada: desativado \(atualizado\)/);
  assert.equal(readGlobal(env).stopGate.enabled, false);
});

test('both gate flags together are a usage error', async (t) => {
  const { cwd, env } = setup(t, { config: { defaultModel: fixtureModelIds()[0] } });
  const result = await runCli(['setup', '--enable-review-gate', '--disable-review-gate'], { env, cwd });
  assert.equal(result.code, 2);
  assert.match(result.stdout + result.stderr, /Escolha --enable-review-gate ou --disable-review-gate/);
});

test('invalid global config refuses gate toggles without changing config.json, but stop-server remains available', async (t) => {
  const { cwd, env } = setup(t, { extra: { OPC_SERVER_URL: 'http://127.0.0.1:9' } });
  fs.mkdirSync(env.OPC_DATA_DIR, { recursive: true });
  const file = path.join(env.OPC_DATA_DIR, 'config.json');
  fs.writeFileSync(file, 'null');
  const before = fs.statSync(file);
  const bytes = fs.readFileSync(file);

  const toggle = await runCli(['setup', '--enable-review-gate', '--json'], { env, cwd });
  assert.equal(toggle.code, 2, toggle.stdout + toggle.stderr);
  assert.match(toggle.stdout + toggle.stderr, /config\.json.*opc config validate/i);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);

  const stop = await runCli(['setup', '--stop-server', '--json'], { env, cwd });
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('invalid workspace config refuses a gate toggle before writing or stopping the server', async (t) => {
  const { cwd, env } = setup(t, { config: { defaultModel: fixtureModelIds()[0] }, extra: { OPC_SERVER_URL: 'http://127.0.0.1:9' } });
  const globalFile = path.join(env.OPC_DATA_DIR, 'config.json');
  const globalBefore = fs.readFileSync(globalFile);
  const workspaceFile = writeWorkspaceConfig(cwd, null);
  const workspaceBefore = fs.readFileSync(workspaceFile);

  const result = await runCli(['setup', '--stop-server', '--enable-review-gate', '--json'], { env, cwd });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /\.opc\.json.*opc config validate/i);
  assert.deepEqual(fs.readFileSync(globalFile), globalBefore);
  assert.deepEqual(fs.readFileSync(workspaceFile), workspaceBefore);
  assert.doesNotMatch(result.stdout, /"mode":\s*"stop"/);
});

test('invalid flag combinations are rejected before the gate config is written', async (t) => {
  const { cwd, env } = setup(t, { config: { defaultModel: fixtureModelIds()[0] } });
  const file = path.join(env.OPC_DATA_DIR, 'config.json');
  const beforeBytes = fs.readFileSync(file);
  const beforeMtime = fs.statSync(file).mtimeMs;

  const result = await runCli(['setup', '--enable-review-gate', '--force'], { env, cwd });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(file), beforeBytes);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
});

test('--stop-server refuses while jobs are active and lists them', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'review-slow', config: { defaultModel: fixtureModelIds()[0] }, extra: { FAKE_SLOW_MS: '60000' } });
  writeFile(cwd, 'src/app.js', "export const value = 'STOP_SERVER_MARKER';\n");
  const started = await runCli(['review', '--background', '--json'], { env: { ...env, OPC_COMPANION_SESSION_ID: 'someone-else' }, cwd });
  assert.equal(started.code, 0, started.stderr);
  const { jobId } = JSON.parse(started.stdout);

  const refused = await runCli(['setup', '--stop-server'], { env, cwd });
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, new RegExp(jobId));
  assert.equal(serverAlive(stateDirFor(env, cwd)), true);

  const cancelled = await runCli(['cancel', jobId], { env, cwd });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const stopped = await runCli(['setup', '--stop-server'], { env, cwd });
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  assert.equal(serverAlive(stateDirFor(env, cwd)), false);
});
