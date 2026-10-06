#!/usr/bin/env node
// Collects tests/<kind>/**/*.test.mjs (or tests/live/*.mjs) and runs `node --test` — portable to Node 20 and 22.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = Object.freeze(['unit', 'integration', 'live']);
// Not collected in tests/live: support modules (_*.mjs) and standalone scripts (contract.mjs, probe-*.mjs).
const LIVE_NOT_TESTS = /^(_.*|contract|probe-.*)\.mjs$/;
// Caps so a hung test fails instead of running forever. node --test-timeout bounds each test FILE (per-process
// isolation) and every test without an explicit timeout; live runs skip it because their tests declare their own
// 30-60 min caps. The run cap kills the whole process group. Overridable via OPC_TEST_TIMEOUT_MS and
// OPC_TEST_RUN_TIMEOUT_MS (milliseconds).
export const TEST_TIMEOUT_MS = 300_000;
export const RUN_TIMEOUT_MS = Object.freeze({ default: 30 * 60_000, live: 6 * 60 * 60_000 });
const MAX_TIMER_MS = 2 ** 31 - 1;
const KILL_GRACE_MS = 5000;
export const TEST_PRELOAD = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'test-exit-after-grace.mjs')).href;
const ORPHAN_POLL_MS = 1000;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function collectTestFiles(root = REPO_ROOT, kinds = ['unit', 'integration']) {
  const files = [];
  for (const kind of kinds) {
    const dir = path.join(root, 'tests', kind);
    const found = walk(dir, []).filter((f) => {
      const name = path.basename(f);
      if (kind === 'live') return path.dirname(f) === dir && name.endsWith('.mjs') && !LIVE_NOT_TESTS.test(name);
      return name.endsWith('.test.mjs');
    });
    files.push(...found.sort());
  }
  return files;
}

function nodeAtLeast(version, major, minor) {
  const [maj, min] = version.replace(/^v/, '').split('.').map(Number);
  return maj > major || (maj === major && min >= minor);
}

export function supportsTestConcurrency(version = process.versions.node) {
  return nodeAtLeast(version, 20, 10);
}

export function supportsTestTimeout(version = process.versions.node) {
  return nodeAtLeast(version, 20, 11);
}

export function supportsTestPreload(version = process.versions.node) {
  return nodeAtLeast(version, 20, 6);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TIMER_MS) : fallback;
}

export function nodeTestArgs(kind, { version = process.versions.node, env = process.env } = {}) {
  const live = kind === 'live';
  const args = ['--test'];
  if (supportsTestConcurrency(version)) args.push(`--test-concurrency=${live ? 1 : 4}`);
  if (!live && supportsTestTimeout(version)) {
    args.push(`--test-timeout=${positiveInt(env.OPC_TEST_TIMEOUT_MS, TEST_TIMEOUT_MS)}`);
  }
  // Exit once the tests are done even if a leaked handle keeps the loop alive, without losing results (see the preload).
  if (supportsTestPreload(version)) args.push(`--import=${TEST_PRELOAD}`);
  return args;
}

export function runTimeoutMs(kind, env = process.env) {
  return positiveInt(env.OPC_TEST_RUN_TIMEOUT_MS, kind === 'live' ? RUN_TIMEOUT_MS.live : RUN_TIMEOUT_MS.default);
}

function killGroup(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

// Runs node --test in its own process group, so a run timeout, a signal, or the death of our parent (a sandbox
// or agent that gave up on us) takes down every test process instead of leaving the tree running forever.
// Limits: being a separate group, a SIGKILL sent to the caller's group no longer reaches the suite (it still ends
// on its own through the exit-after-grace preload and the per-file cap for unit/integration; live relies on its tests' own
// timeouts); on Windows only the direct child is killed and the parent watchdog never fires (ppid does not change).
export function runNodeTest(args, { env, cwd, timeoutMs, pollMs = ORPHAN_POLL_MS }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env, cwd, detached: process.platform !== 'win32' });
    const parent = process.ppid;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let reason = null;
    let stopCode = 1;
    let killTimer = null;
    const stopAll = (why, code) => {
      if (reason) return;
      reason = why;
      stopCode = code;
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => stopAll(`timeout de ${Math.round(timeoutMs / 1000)} s`, 124), timeoutMs);
    const watchdog = setInterval(() => {
      if (process.ppid !== parent) stopAll('processo pai encerrado', 1);
    }, pollMs);
    const onSignal = (signal) => stopAll(signal, 128 + (os.constants.signals[signal] ?? 0));
    for (const signal of signals) process.on(signal, onSignal);
    const finish = (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(watchdog);
      for (const signal of signals) process.off(signal, onSignal);
      if (reason) process.stderr.write(`opc: suíte interrompida (${reason}); grupo de processos encerrado\n`);
      resolve(code);
    };
    child.once('error', (err) => {
      process.stderr.write(`opc: falha ao iniciar node --test: ${err.message}\n`);
      finish(1);
    });
    child.once('exit', (code) => {
      // Leftovers still in the group (e.g. a child whose cleanup hook never ran) go down with the run.
      killGroup(child, 'SIGKILL');
      finish(reason ? stopCode : (code ?? 1));
    });
  });
}

export function nodeVersionExitCode(version = process.versions.node) {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return Number.isInteger(major) && major >= 20 ? 0 : 2;
}

async function main(argv) {
  const requested = argv[0];
  if (requested && !KINDS.includes(requested)) {
    process.stderr.write(`usage: node scripts/run-tests.mjs [${KINDS.join('|')}]\n`);
    return 2;
  }
  const kinds = requested ? [requested] : ['unit', 'integration'];
  const files = collectTestFiles(REPO_ROOT, kinds);
  if (files.length === 0) {
    process.stderr.write(`no test files found for: ${kinds.join(', ')}\n`);
    return 1;
  }
  const env = requested === 'live' ? { ...process.env, OPC_LIVE: '1' } : process.env;
  return runNodeTest([...nodeTestArgs(requested), ...files], { env, cwd: REPO_ROOT, timeoutMs: runTimeoutMs(requested) });
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const versionExitCode = nodeVersionExitCode();
  if (versionExitCode !== 0) {
    process.stderr.write(`opc: Node >= 20 é necessário (atual: ${process.version})\n`);
    process.exit(versionExitCode);
  }
  process.exit(await main(process.argv.slice(2)));
}
