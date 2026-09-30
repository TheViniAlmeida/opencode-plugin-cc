// Shared test helpers (F0). Later phases only APPEND at the end of this file (never rewrite it), using the
// default imports below (fs, os, path, spawn, execFileSync) or aliased imports (`<phase><Name>`), and never
// re-export a name that already exists here (a duplicate export is a SyntaxError).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeConfig } from '../plugins/opc/scripts/lib/config.mjs';
import { getProcessIdentity, identityMatches } from '../plugins/opc/scripts/lib/process.mjs';
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
          if (result && typeof result === 'object') {
            requireStopped(result);
          }
        } catch (err) {
          errors.push(err);
        }
      }
      if (fs.existsSync(COMPANION)) {
        for (const env of reg.envs) {
          errors.push(...await stopAllWorkspaces(env, reg.workspaces.filter((ws) => fs.existsSync(ws))));
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

// ---- F4b: orchestration helpers (appended) ----
// Reads the turn log written by the orchestration scenarios (tests/fixtures/orchestrate-turns.mjs).
export function readTurnLog(env) {
  const file = `${env.FAKE_OPENCODE_STATE}.turns.jsonl`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
// ---- end F4b ----

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
export function requireStopped(result, env) {
  if (result?.stopped === true || (result?.stopped === false && result.reason === 'attached')) return result;
  if (result?.stopped === false && result.reason === 'not-running') {
    if (env?.FAKE_OPENCODE_STATE) {
      const fakeBin = path.join(FAKE_BIN_DIR, 'opencode');
      const matcher = (cmdline) => cmdline.includes(fakeBin) && cmdline.includes('serve');
      for (const boot of readFakeState(env).boots) {
        // Boots record PIDs only: recheck the current identity and fake cmdline without signaling.
        const identity = getProcessIdentity(boot.pid);
        if (identity && identityMatches(identity, matcher)) {
          throw new Error(`server stop not confirmed: live fake server pid ${boot.pid}; state: ${env.FAKE_OPENCODE_STATE}`);
        }
      }
    }
    return result;
  }
  throw new Error(`server stop not confirmed: ${result?.reason ?? 'missing result'}`);
}

export async function stopAllWorkspaces(env, workspaces, stop = stopAllServers) {
  const errors = [];
  for (const ws of workspaces) {
    try {
      const result = await stop(env, ws);
      if (result.code !== 0) {
        errors.push(new Error(`stopAllServers failed (code ${result.code}) for ${ws}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`));
      } else {
        requireStopped(parseJsonOutput(result.stdout).stop);
      }
    } catch (err) {
      errors.push(err);
    }
  }
  try { requireStopped({ stopped: false, reason: 'not-running' }, env); }
  catch (err) { errors.push(err); }
  return errors;
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
        return requireStopped(await stop(ctx, { force: true, confirmedByUser: true }), ctx.env);
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

// ---- F1 additions (aliased imports so they never collide with F0's) ----
import { PassThrough as F1PassThrough, Writable as F1Writable } from 'node:stream';
import * as fsF1 from 'node:fs';
import * as pathF1 from 'node:path';
import { pathToFileURL as pathToFileURLF1 } from 'node:url';

export function scriptedTTY(lines) {
  const input = new F1PassThrough();
  input.isTTY = true;
  input.end(lines.map((line) => `${line}\n`).join(''));
  return input;
}

export function pipedStdin(text = '') {
  const input = new F1PassThrough();
  input.isTTY = false;
  input.end(text);
  return input;
}

export function captureStream({ isTTY = false } = {}) {
  const chunks = [];
  const stream = new F1Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  stream.isTTY = isTTY;
  stream.text = () => chunks.join('');
  return stream;
}

export function fixtureData(name) {
  return JSON.parse(fsF1.readFileSync(pathF1.join(REPO_ROOT, 'tests', 'fixtures', 'data', name), 'utf8'));
}

// Canonical writer of <OPC_DATA_DIR>/config.json for every phase (mode 600) → file path.
export function writeGlobalConfig(env, cfg) {
  fsF1.mkdirSync(env.OPC_DATA_DIR, { recursive: true, mode: 0o700 });
  fsF1.chmodSync(env.OPC_DATA_DIR, 0o700);
  const file = pathF1.join(env.OPC_DATA_DIR, 'config.json');
  fsF1.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fsF1.chmodSync(file, 0o600);
  return file;
}

export function readGlobalConfig(env) {
  const file = pathF1.join(env.OPC_DATA_DIR, 'config.json');
  return fsF1.existsSync(file) ? JSON.parse(fsF1.readFileSync(file, 'utf8')) : null;
}

// Canonical writer of <ws>/.opc.json → file path.
export function writeWorkspaceConfig(ws, cfg) {
  const file = pathF1.join(ws, '.opc.json');
  fsF1.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

export async function runInProcess(sub, argv, { env, cwd, stdin = pipedStdin('') }) {
  const lib = (m) => pathToFileURLF1(pathF1.join(PLUGIN_ROOT, 'scripts', 'lib', m)).href;
  const { createContext } = await import(lib('context.mjs'));
  const { toExitCode } = await import(lib('opc-error.mjs'));
  const { renderError } = await import(lib('render.mjs'));
  const mod = await import(pathToFileURLF1(pathF1.join(PLUGIN_ROOT, 'scripts', 'commands', `${sub}.mjs`)).href);
  const stdout = captureStream();
  const stderr = captureStream();
  let code;
  try {
    const ctx = await createContext({ argv, env, cwd, stdin, stdout, stderr, ...(mod.contextOptions?.(argv) ?? {}) });
    code = await mod.run(ctx, argv);
  } catch (err) {
    stderr.write(renderError(err));
    code = toExitCode(err);
  }
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
// ---- end F1 additions ----

// ---- F2a helpers (appended; F0/F1 helpers above stay unchanged) ----
import { resolveWorkspaceRoot as f2aResolveWorkspaceRoot, workspaceStateDir as f2aWorkspaceStateDir } from '../plugins/opc/scripts/lib/state.mjs';
import { listJobs as f2aListJobs, readJob as f2aReadJob } from '../plugins/opc/scripts/lib/jobs.mjs';

export const F2A_PROVIDER = 'omniroute-personal';
export const F2A_MODEL_ID = 'opencode-go/deepseek-v4.1-flash';
export const F2A_MODEL = `${F2A_PROVIDER}/${F2A_MODEL_ID}`;
export const F2A_POLICY = Object.freeze({
  providers: { allow: [], deny: ['omniroute-work'] },
  models: { allow: [], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: ['gitlab_*'] },
  sensitivePaths: ['*.env', '**/.ssh/**'],
  destructiveBash: ['make nuke*'],
  approver: 'user',
  permissionTimeoutSec: 600,
});

export function stateDirFor(env, cwd) {
  return f2aWorkspaceStateDir(env.OPC_DATA_DIR, f2aResolveWorkspaceRoot(cwd));
}

export function jobsIn(env, cwd) {
  return f2aListJobs(stateDirFor(env, cwd), { all: true });
}

export function jobIn(env, cwd, id) {
  return f2aReadJob(stateDirFor(env, cwd), id);
}

export function requestsTo(env, method, path) {
  const requests = readFakeState(env).requests ?? [];
  return requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)));
}

export function jobIdFrom(output) {
  const match = /\b((?:task|ask|plan)-[0-9a-z]+-[0-9a-z]{6})\b/.exec(output);
  if (!match) throw new Error(`no job id in: ${output.slice(0, 500)}`);
  return match[1];
}

// Workspace + env + global config. Active jobs are cancelled by a registerStopper, which the F0 per-test
// cleanup runs BEFORE it stops the servers and removes the temp dirs.
export function setupF2a(t, { scenario = 'ok', config = {}, extraEnv = {}, git = true } = {}) {
  const ctx = {};
  ctx.cwd = makeWorkspace(t, { git });
  ctx.env = testEnv(t, { scenario, extra: { OPC_COMPANION_SESSION_ID: 'claude-f2a', OPC_STATUS_POLL_MS: '200', ...extraEnv } });
  registerStopper(t, async () => {
    for (const job of jobsIn(ctx.env, ctx.cwd)) {
      if (['queued', 'running', 'waiting_permission'].includes(job.status)) await runCli(['cancel', job.id], { env: ctx.env, cwd: ctx.cwd });
    }
  });
  writeGlobalConfig(ctx.env, { defaultProvider: F2A_PROVIDER, defaultModel: F2A_MODEL, policy: F2A_POLICY, ...config });
  return ctx;
}

export const opc = (ctx, args, { stdin = '', timeoutMs = 60000, env = {} } = {}) =>
  runCli(args, { env: { ...ctx.env, ...env }, cwd: ctx.cwd, stdin, timeoutMs });

// ---- F2b helpers (appended) ----
// Requests recorded by the fake spawned for `env` (readFakeState, F0); [] when no server was started.
export function fakeRequests(env) {
  return readFakeState(env).requests ?? [];
}
// ---- end F2b ----

// ---- F3 helpers (appended) ----
import { randomBytes as f3RandomBytes } from 'node:crypto';

// Starts a fake OpenCode server in-process (not spawned by opc) for OPC_SERVER_URL tests. Its temp dir goes to
// the F0 per-test cleanup; fake.close() is a plain t.after (it must stay up while the cleanup runs
// `setup --stop-server` in attach mode).
export async function startExternalFake(t, { scenario = 'f3-sessions' } = {}) {
  const { startFake } = await import('./fixtures/fake-opencode.mjs');
  const { pickFreePort } = await import('../plugins/opc/scripts/lib/server.mjs');
  const dir = trackTempDir(t, makeTempDir('opc-ext-'));
  const password = f3RandomBytes(24).toString('hex');
  const stateFile = path.join(dir, 'fake-state.json');
  const fake = await startFake({ port: await pickFreePort(), password, scenario, stateFile });
  t.after(() => fake.close());
  return { url: fake.url, password, stateFile, fake };
}

// waitFor (F0) that also treats a throwing predicate as "not yet"; the last error goes into the timeout message.
export async function eventually(fn, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  let lastError;
  try {
    return await waitFor(async () => {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        return false;
      }
    }, { timeoutMs, intervalMs, message: 'eventually' });
  } catch {
    throw new Error(`eventually: condition not met in ${timeoutMs} ms${lastError ? `: ${lastError.message}` : ''}`);
  }
}
// ---- end F3 ----

// ---- F4a helpers (appended; reuses writeGlobalConfig/writeWorkspaceConfig F1, stateDirFor/jobsIn/requestsTo F2a,
// waitFor F0 — never redefined) ----
export const FIXTURE_MODELS = Object.freeze({
  fast: 'omniroute-personal/opencode-go/deepseek-v4.1-flash',
  strong: 'omniroute-personal/opencode-go/qwen3.8-max',
  k3: 'omniroute-personal/opencode-go/kimi-k3',
});

export function promptModels(env) {
  return requestsTo(env, 'POST', /^\/session\/[^/]+\/prompt_async$/)
    .map((r) => `${r.body?.model?.providerID}/${r.body?.model?.modelID}`);
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: match[2] };
}
