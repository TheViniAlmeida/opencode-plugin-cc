import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, makeTempDir, trackTempDir } from '../helpers.mjs';
import { setStopGateEnabled } from '../../plugins/opc/scripts/lib/config.mjs';
import { contextOptions as setupContextOptions, reviewGateChange } from '../../plugins/opc/scripts/commands/setup.mjs';
import { contextOptions as configContextOptions } from '../../plugins/opc/scripts/commands/config.mjs';
import { acquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { run as runSetup } from '../../plugins/opc/scripts/commands/setup.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';

function dataDir(t) {
  return trackTempDir(t, makeTempDir('opc-gate-cfg-'));
}

function setupContext(t, configText = JSON.stringify({ defaultModel: 'p/m' })) {
  const dataDirPath = dataDir(t);
  fs.mkdirSync(path.join(dataDirPath, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDirPath, 'config.json'), configText, { mode: 0o600 });
  const output = [];
  const ctx = {
    dataDir: dataDirPath,
    workspaceRoot: path.join(dataDirPath, 'workspace'),
    stateDir: path.join(dataDirPath, 'state'),
    env: { OPC_SERVER_URL: 'http://127.0.0.1:9' },
    config: DEFAULT_CONFIG,
    configWarnings: [],
    configMeta: { hasGlobal: true, workspaceFound: false },
    out: (value) => output.push(String(value)),
    err: (value) => output.push(String(value)),
    json: (value) => output.push(JSON.stringify(value)),
  };
  return { ctx, output, file: path.join(dataDirPath, 'config.json') };
}

test('setStopGateEnabled refuses to create the global config', async (t) => {
  const dir = dataDir(t);
  await assert.rejects(setStopGateEnabled(dir, true), (err) => err.exitCode === 2 && /Execute o onboarding/.test(err.message));
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

test('setStopGateEnabled flips stopGate.enabled and keeps every other key', async (t) => {
  const dir = dataDir(t);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'p/m', stopGate: { enabled: false, model: 'p/gate' } }), { mode: 0o600 });
  await setStopGateEnabled(dir, true);
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.stopGate.enabled, true);
  assert.equal(saved.stopGate.model, 'p/gate');
  assert.equal(saved.defaultModel, 'p/m');
  await setStopGateEnabled(dir, false);
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.stopGate.enabled, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('setStopGateEnabled waits on config.lock and preserves keys written by the lock owner', async (t) => {
  const dir = dataDir(t);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'p/m', delegation: { auto: false } }), { mode: 0o600 });
  const release = await acquireLock(path.join(dir, 'config.lock'), { timeoutMs: 1000, purpose: 'test-config-writer' });
  const toggling = setStopGateEnabled(dir, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'p/m', delegation: { auto: true } }), { mode: 0o600 });
  release();
  await toggling;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.stopGate.enabled, true);
  assert.equal(saved.delegation.auto, true);
});

test('setup rejects --force without --stop-server before changing config bytes or mtime', async (t) => {
  const { ctx, file } = setupContext(t);
  const bytes = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  await assert.rejects(runSetup(ctx, ['--enable-review-gate', '--force']), (err) => err.code === 'USAGE');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('setup rejects unconfirmed --force before changing config bytes or mtime', async (t) => {
  const { ctx, file } = setupContext(t);
  const bytes = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  await assert.rejects(runSetup(ctx, ['--enable-review-gate', '--stop-server', '--force']), (err) => err.code === 'CONFIRMATION_REQUIRED');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('setup refuses invalid global config for gate changes but allows stop-server alone', async (t) => {
  const { ctx, file } = setupContext(t, 'null');
  const bytes = fs.readFileSync(file);
  await assert.rejects(runSetup(ctx, ['--enable-review-gate']), (err) => err.code === 'CONFIG_INVALID' && err.exitCode === 2 && /opc config validate/.test(err.message));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(await runSetup(ctx, ['--stop-server', '--json']), 0);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('setup gate flags toggle global config and include JSON and Markdown output', async (t) => {
  const { ctx, output, file } = setupContext(t);
  await runSetup(ctx, ['--enable-review-gate', '--stop-server', '--json']);
  assert.deepEqual(JSON.parse(output.at(-1)).reviewGate, { enabled: true, changed: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stopGate.enabled, true);
  output.length = 0;
  await runSetup(ctx, ['--stop-server']);
  assert.match(output.join(''), /Gate de parada: ativado/);
});

test('reviewGateChange maps the flags and refuses both at once', () => {
  assert.equal(reviewGateChange({}), null);
  assert.equal(reviewGateChange({ 'enable-review-gate': true }), true);
  assert.equal(reviewGateChange({ 'disable-review-gate': true }), false);
  assert.throws(() => reviewGateChange({ 'enable-review-gate': true, 'disable-review-gate': true }), (err) => err.exitCode === 2);
});

test('setup owns invalid-config tolerance for stop and gate controls', () => {
  assert.deepEqual(setupContextOptions(['--stop-server']), { allowInvalidConfig: true });
  assert.deepEqual(setupContextOptions(['--enable-review-gate']), { allowInvalidConfig: true });
  assert.deepEqual(setupContextOptions(['--disable-review-gate']), { allowInvalidConfig: true });
  assert.deepEqual(setupContextOptions(['--json']), {});
});

test('config owns invalid-config tolerance only for validate', () => {
  assert.deepEqual(configContextOptions(['validate', '--json']), { allowInvalidConfig: true });
  assert.deepEqual(configContextOptions(['show', '--json']), {});
});

test('/opc:setup advertises the review gate flags', () => {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'setup.md'), 'utf8');
  assert.match(text, /^argument-hint: .*--enable-review-gate\|--disable-review-gate/m);
});
