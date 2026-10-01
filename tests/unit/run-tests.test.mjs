import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  collectTestFiles, nodeTestArgs, nodeVersionExitCode, runNodeTest, runTimeoutMs, RUN_TIMEOUT_MS,
  supportsTestConcurrency, supportsTestForceExit, supportsTestTimeout, TEST_TIMEOUT_MS,
} from '../../scripts/run-tests.mjs';
import { makeTempDir, processAlive, removeTempDir, waitFor } from '../helpers.mjs';

function touch(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('collectTestFiles finds *.test.mjs recursively under unit and integration, sorted', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/unit/b.test.mjs');
  touch(root, 'tests/unit/a.test.mjs');
  touch(root, 'tests/unit/nested/c.test.mjs');
  touch(root, 'tests/unit/helper.mjs');
  touch(root, 'tests/integration/x.test.mjs');
  const files = collectTestFiles(root).map((f) => path.relative(root, f));
  assert.deepEqual(files, [
    path.join('tests', 'unit', 'a.test.mjs'),
    path.join('tests', 'unit', 'b.test.mjs'),
    path.join('tests', 'unit', 'nested', 'c.test.mjs'),
    path.join('tests', 'integration', 'x.test.mjs'),
  ]);
});

test('collectTestFiles for live skips standalone scripts (contract, probe-*) and support modules (_*)', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/live/f0-connection.mjs');
  touch(root, 'tests/live/contract.mjs');
  touch(root, 'tests/live/probe-permission-precedence.mjs');
  touch(root, 'tests/live/_f2a-helpers.mjs');
  const files = collectTestFiles(root, ['live']).map((f) => path.basename(f));
  assert.deepEqual(files, ['f0-connection.mjs']);
});

test('supportsTestConcurrency is true from Node 20.10', () => {
  assert.equal(supportsTestConcurrency('20.9.0'), false);
  assert.equal(supportsTestConcurrency('20.10.0'), true);
  assert.equal(supportsTestConcurrency('22.1.0'), true);
});

test('collectTestFiles propagates non-ENOENT directory errors', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'unit'), 'not a directory');
  assert.throws(() => collectTestFiles(root, ['unit']), { code: 'ENOTDIR' });
});

test('Node CLI version guard returns exit 2 below major 20', () => {
  assert.equal(nodeVersionExitCode('v18.20.0'), 2);
  assert.equal(nodeVersionExitCode('v20.0.0'), 0);
});

test('test timeout and force-exit flags are gated by Node version', () => {
  assert.equal(supportsTestTimeout('20.10.0'), false);
  assert.equal(supportsTestTimeout('20.11.0'), true);
  assert.equal(supportsTestForceExit('20.13.1'), false);
  assert.equal(supportsTestForceExit('v20.14.0'), true);
  assert.equal(supportsTestForceExit('22.0.0'), true);
});

test('nodeTestArgs caps each file and forces exit; live runs serially and keeps its own per-test caps', () => {
  assert.deepEqual(nodeTestArgs(undefined, { version: '22.22.1', env: {} }), [
    '--test', '--test-concurrency=4', `--test-timeout=${TEST_TIMEOUT_MS}`, '--test-force-exit',
  ]);
  // --test-timeout bounds a whole file under process isolation: it would cut the 30-60 min live tests.
  assert.deepEqual(nodeTestArgs('live', { version: '22.22.1', env: { OPC_TEST_TIMEOUT_MS: '5000' } }), [
    '--test', '--test-concurrency=1', '--test-force-exit',
  ]);
  assert.deepEqual(nodeTestArgs('unit', { version: '20.9.0', env: {} }), ['--test']);
  assert.ok(nodeTestArgs('unit', { version: '22.22.1', env: { OPC_TEST_TIMEOUT_MS: '5000' } }).includes('--test-timeout=5000'));
  assert.ok(nodeTestArgs('unit', { version: '22.22.1', env: { OPC_TEST_TIMEOUT_MS: 'x' } })
    .includes(`--test-timeout=${TEST_TIMEOUT_MS}`));
});

test('runTimeoutMs defaults per kind and honors a positive integer override', () => {
  assert.equal(runTimeoutMs('unit', {}), RUN_TIMEOUT_MS.default);
  assert.equal(runTimeoutMs('live', {}), RUN_TIMEOUT_MS.live);
  assert.equal(runTimeoutMs('unit', { OPC_TEST_RUN_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(runTimeoutMs('unit', { OPC_TEST_RUN_TIMEOUT_MS: '-1' }), RUN_TIMEOUT_MS.default);
  // Above the 32-bit timer limit setTimeout would fire at once; the override is clamped instead.
  assert.equal(runTimeoutMs('unit', { OPC_TEST_RUN_TIMEOUT_MS: String(2 ** 40) }), 2 ** 31 - 1);
});

// A hung run with a grandchild: the run timeout must take down the whole process group, not just the child.
const HUNG_WITH_GRANDCHILD = (pidFile, exitAfterSpawn) => `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
g.unref();
fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${exitAfterSpawn ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
`;

function trackGrandchild(t, pidFile) {
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  });
}

test('runNodeTest: the run timeout kills the whole process group and reports 124', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  const pidFile = path.join(root, 'grandchild.pid');
  trackGrandchild(t, pidFile);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const code = await runNodeTest(['-e', HUNG_WITH_GRANDCHILD(pidFile, false)], { env: process.env, cwd: root, timeoutMs: 1500 });
  stderr.mock.restore();
  assert.equal(code, 124);
  assert.ok(stderr.mock.calls.some((c) => /suíte interrompida \(timeout/.test(String(c.arguments[0]))));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !processAlive(pid), { timeoutMs: 8000, message: 'grandchild killed with the group' });
});

test('runNodeTest: leftovers in the group die when the run exits on its own', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  const pidFile = path.join(root, 'grandchild.pid');
  trackGrandchild(t, pidFile);
  const code = await runNodeTest(['-e', HUNG_WITH_GRANDCHILD(pidFile, true)], { env: process.env, cwd: root, timeoutMs: 60_000 });
  assert.equal(code, 0);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !processAlive(pid), { timeoutMs: 5000, message: 'leftover killed with the group' });
});

// A real runner process (B) driving a hung run whose grandchild records its pid.
const RUNNER = (pidFile) => `
import { runNodeTest } from ${JSON.stringify(new URL('../../scripts/run-tests.mjs', import.meta.url).href)};
const script = ${JSON.stringify(HUNG_WITH_GRANDCHILD(pidFile, false))};
process.exit(await runNodeTest(['-e', script], { env: process.env, cwd: process.cwd(), timeoutMs: 60_000, pollMs: 100 }));
`;

async function waitForPid(pidFile) {
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, { timeoutMs: 8000, message: 'grandchild pid' });
  return Number(fs.readFileSync(pidFile, 'utf8'));
}

test('runNodeTest: SIGTERM to the runner takes down the group and exits 143', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  const pidFile = path.join(root, 'grandchild.pid');
  trackGrandchild(t, pidFile);
  const runner = spawn(process.execPath, ['--input-type=module', '-e', RUNNER(pidFile)], { cwd: root, stdio: 'ignore' });
  t.after(() => { try { runner.kill('SIGKILL'); } catch { /* already gone */ } });
  const pid = await waitForPid(pidFile);
  const exited = new Promise((resolve) => runner.once('exit', (code) => resolve(code)));
  runner.kill('SIGTERM');
  assert.equal(await exited, 143);
  await waitFor(() => !processAlive(pid), { timeoutMs: 8000, message: 'grandchild killed on SIGTERM' });
});

test('runNodeTest: when the runner is orphaned its watchdog takes down the group', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  const pidFile = path.join(root, 'grandchild.pid');
  const runnerPidFile = path.join(root, 'runner.pid');
  trackGrandchild(t, pidFile);
  t.after(() => { try { process.kill(Number(fs.readFileSync(runnerPidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ } });
  // The intermediate parent starts the runner detached and dies once the grandchild is up, orphaning the runner.
  const intermediate = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const r = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(RUNNER(pidFile))}], { stdio: 'ignore', detached: true });
fs.writeFileSync(${JSON.stringify(runnerPidFile)}, String(r.pid));
const tick = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(tick); process.exit(0); } }, 50);
`;
  await new Promise((resolve, reject) => {
    spawn(process.execPath, ['-e', intermediate], { cwd: root, stdio: 'ignore' }).once('error', reject).once('exit', resolve);
  });
  const pid = await waitForPid(pidFile);
  const runnerPid = Number(fs.readFileSync(runnerPidFile, 'utf8'));
  await waitFor(() => !processAlive(pid), { timeoutMs: 10000, message: 'grandchild killed by the orphan watchdog' });
  await waitFor(() => !processAlive(runnerPid), { timeoutMs: 10000, message: 'orphaned runner exited' });
});
