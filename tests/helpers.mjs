// Shared test helpers (F0). Later phases only APPEND at the end of this file (never rewrite it), using the
// default imports below (fs, os, path, spawn, execFileSync) or aliased imports (`<phase><Name>`), and never
// re-export a name that already exists here (a duplicate export is a SyntaxError).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeConfig } from '../plugins/opc/scripts/lib/config.mjs';
import { stopServer } from '../plugins/opc/scripts/lib/server.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../plugins/opc/scripts/lib/state.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'opc');
export const PLUGIN_BIN_DIR = path.join(PLUGIN_ROOT, 'bin');
export const COMPANION = path.join(PLUGIN_ROOT, 'scripts', 'opc-companion.mjs');
export const FAKE_BIN_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'bin');

const TEMP_PREFIX = 'opc-';
const cleanups = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeTempDir(prefix = 'opc-test-') {
  const safe = prefix.startsWith(TEMP_PREFIX) ? prefix : `${TEMP_PREFIX}${prefix}`;
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), safe)));
}

export function removeTempDir(dir) {
  const tmp = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== tmp || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove non-temporary directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function registry(t) {
  let reg = cleanups.get(t);
  if (!reg) {
    reg = { stoppers: [], envs: [], workspaces: [], dirs: [] };
    cleanups.set(t, reg);
    t.after(async () => {
      const errors = [];
      for (const stop of [...reg.stoppers].reverse()) {
        try {
          const result = await stop();
          if (result && typeof result === 'object') requireStopped(result);
        } catch (err) {
          errors.push(err);
        }
      }
      if (fs.existsSync(COMPANION)) {
        for (const env of reg.envs) {
          for (const ws of reg.workspaces) {
            if (!fs.existsSync(ws)) continue;
            try {
              const result = await stopAllServers(env, ws);
              if (result.code !== 0) {
                errors.push(new Error(`stopAllServers failed (code ${result.code}) for ${ws}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`));
              } else {
                requireStopped(parseJsonOutput(result.stdout).stop);
              }
            } catch (err) {
              errors.push(err);
            }
          }
        }
      }
      for (const dir of reg.dirs) {
        if (errors.length) {
          process.stderr.write(`test cleanup: diretório preservado para recuperação: ${dir}\n`);
          continue;
        }
        try {
          removeTempDir(dir);
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length) throw new AggregateError(errors, `test cleanup failed:\n${errors.map((err) => err?.stack ?? String(err)).join('\n')}`);
    });
  }
  return reg;
}

export function registerStopper(t, fn) {
  registry(t).stoppers.push(fn);
}

export function trackTempDir(t, dir) {
  registry(t).dirs.push(dir);
  return dir;
}

// Registers a directory where servers may run (git worktrees, dirs not made by makeWorkspace): the per-test
// cleanup runs `stopAllServers(env, dir)` for it with every tracked env, before removing the temp dirs.
export function trackWorkspace(t, dir) {
  const real = fs.realpathSync(dir);
  const reg = registry(t);
  if (!reg.workspaces.includes(real)) reg.workspaces.push(real);
  return real;
}

// Registers an env built outside testEnv (live tests): its servers are stopped by the per-test cleanup.
export function trackEnv(t, env) {
  const reg = registry(t);
  if (!reg.envs.includes(env)) reg.envs.push(env);
  return env;
}

export function makeWorkspace(t, { git = true, name = 'ws' } = {}) {
  const base = trackTempDir(t, makeTempDir('opc-ws-'));
  const ws = path.join(base, name);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), '# test workspace\n');
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
    run('init', '-q');
    run('config', 'user.name', 'opc-test');
    run('config', 'user.email', 'opc-test@example.invalid');
    run('config', 'commit.gpgsign', 'false');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  }
  return trackWorkspace(t, ws);
}

const INHERITED_BLOCKLIST = /^(OPC_|CLAUDE_PLUGIN_DATA$|OPENCODE_|FAKE_)/;

export function testEnv(t, { scenario = 'ok', extra = {} } = {}) {
  const base = trackTempDir(t, makeTempDir('opc-env-'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED_BLOCKLIST.test(k)));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...inherited,
    PATH: `${FAKE_BIN_DIR}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    OPC_DATA_DIR: path.join(base, 'data'),
    FAKE_OPENCODE_SCENARIO: scenario,
    FAKE_OPENCODE_STATE: path.join(base, 'fake-state.json'),
    FAKE_HEARTBEAT_MS: '200',
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined || v === null) delete env[k];
  return trackEnv(t, env);
}

export async function runCli(args, { env, cwd, stdin = '', timeoutMs = 60000 } = {}) {
  return runProcess(process.execPath, [COMPANION, ...args], { env, cwd, stdin, timeoutMs });
}

export async function runProcess(command, args, { env, cwd, stdin = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout after ${timeoutMs} ms: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`stdout is not JSON: ${err.message}\n${stdout}`);
  }
}

export function readFakeState(env) {
  let content;
  try {
    content = fs.readFileSync(env.FAKE_OPENCODE_STATE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`failed to read fake state file ${env.FAKE_OPENCODE_STATE}: ${err.message}`, { cause: err });
    return { requests: [], sessions: {}, messages: {}, permissions: {}, questions: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [] };
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`failed to parse fake state file ${env.FAKE_OPENCODE_STATE}: ${err.message}`, { cause: err });
  }
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function stopAllServers(env, cwd) {
  return runCli(['setup', '--stop-server', '--force', '--confirmed-by-user', '--json'], { env, cwd, timeoutMs: 30000 });
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch {
      return false;
    }
  }
  return true;
}

export async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
    await sleep(intervalMs);
  }
}

export function spawnSleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  });
  return child;
}

export function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const { pid } = child;
  return new Promise((resolve) => child.on('exit', () => resolve(pid)));
}

export function makeServerCtx(t, { scenario = 'ok', extraEnv = {}, config = {} } = {}) {
  const env = testEnv(t, { scenario, extra: extraEnv });
  const ws = makeWorkspace(t);
  ensurePrivateDir(path.join(env.OPC_DATA_DIR, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(env.OPC_DATA_DIR, ws));
  const ctx = { stateDir, workspaceRoot: ws, config: mergeConfig(config, null).config, env, hasActiveJobs: () => false };
  registerStopper(t, async () => requireStopped(await stopServer({ ...ctx, hasActiveJobs: () => false }, { force: true, confirmedByUser: true })));
  return { ctx, env, ws, stateDir };
}

// A successful CLI exit alone does not confirm that a managed server stopped.
export function requireStopped(result) {
  if (result?.stopped === true || (result?.stopped === false && result.reason === 'not-running')) return result;
  throw new Error(`server stop not confirmed: ${result?.reason ?? 'missing result'}`);
}

// Shared by standalone live scripts. Remember failures even when a retry succeeds,
// and keep every tracked server record available for manual recovery.
export function createServerCleanup(dir, { stop = stopServer } = {}) {
  const contexts = new Map();
  const errors = [];
  const cleanup = {
    track(ctx) {
      contexts.set(ctx.stateDir, ctx);
      return ctx;
    },
    async stop(ctx) {
      cleanup.track(ctx);
      try {
        return requireStopped(await stop(ctx, { force: true, confirmedByUser: true }));
      } catch (err) {
        errors.push(err);
        throw err;
      }
    },
    async finish(stoppers = []) {
      for (const stopper of stoppers) {
        try { await stopper(); } catch (err) { errors.push(err); }
      }
      for (const ctx of contexts.values()) {
        try { await cleanup.stop(ctx); } catch { /* Recorded above; finish fails below. */ }
      }
      if (errors.length) {
        const message = `server cleanup failed; diretório preservado para recuperação: ${dir}`;
        process.stderr.write(`${message}\n`);
        throw new AggregateError(errors, message);
      }
      removeTempDir(dir);
    },
  };
  return cleanup;
}
