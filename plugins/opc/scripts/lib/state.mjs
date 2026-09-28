// Data directory, per-workspace state directory, atomic writes, private modes (spec §3.2).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withLock } from './locks.mjs';
import { OpcError, UsageError } from './opc-error.mjs';

export const PLUGIN_DATA_ID = 'opc-opencode-plugin-cc';
export const ACTIVE_JOB_STATUSES = Object.freeze(['queued', 'running', 'waiting_permission']);
const STATE_LOCK_TIMEOUT_MS = 10000;

export function defaultDataDir({ home = os.homedir(), pluginDataId = PLUGIN_DATA_ID } = {}) {
  return path.join(home, '.claude', 'plugins', 'data', pluginDataId);
}

export function resolveDataDir(env = process.env, { home = os.homedir(), pluginDataId = PLUGIN_DATA_ID } = {}) {
  if (env.OPC_DATA_DIR) return path.resolve(env.OPC_DATA_DIR);
  if (env.CLAUDE_PLUGIN_DATA) return path.resolve(env.CLAUDE_PLUGIN_DATA);
  const candidate = defaultDataDir({ home, pluginDataId });
  if (fs.existsSync(candidate)) return candidate;
  throw new OpcError(
    'DATA_DIR_UNRESOLVED',
    'Diretório de dados do opc não encontrado. Rode /opc:setup dentro do Claude Code (ou defina OPC_DATA_DIR).',
    { exitCode: 2 },
  );
}

export function resolveWorkspaceRoot(cwd, { runner = spawnSync, env = process.env } = {}) {
  let real;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new UsageError('USAGE', `Diretório não encontrado: ${cwd}`);
  }
  let res;
  try {
    res = runner('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', shell: false, env });
  } catch (cause) {
    if (cause.code === 'ENOENT') return real;
    throw new OpcError('WORKSPACE_UNRESOLVED', 'Não foi possível resolver o workspace.', { exitCode: 2, details: { path: real }, cause });
  }
  if (res.status === 0 && res.stdout.trim()) {
    try {
      return fs.realpathSync.native(res.stdout.trim());
    } catch {
      return real;
    }
  }
  if (res.error?.code === 'ENOENT' || (res.status === 128 && /not a git repository/i.test(res.stderr ?? ''))) return real;
  throw new OpcError('WORKSPACE_UNRESOLVED', 'Não foi possível resolver o workspace.', {
    exitCode: 2,
    details: { path: real, status: res.status, error: res.error?.code },
  });
}

function slugFor(dir) {
  const base = path.basename(dir) || 'workspace';
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'workspace';
}

export function workspaceStateDir(dataDir, workspaceRoot) {
  let real = workspaceRoot;
  try {
    real = fs.realpathSync.native(workspaceRoot);
  } catch {
    real = path.resolve(workspaceRoot);
  }
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return path.join(dataDir, 'state', `${slugFor(real)}-${hash}`);
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new OpcError('UNSAFE_DIR', `O diretório ${dir} pertence a outro usuário; o opc não vai usá-lo.`, { exitCode: 2 });
  }
  if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

export function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const content = typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* preserve the atomic write failure */ }
    throw err;
  }
}

export function readJson(filePath, fallback) {
  let raw;
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o444;
      if (mode === 0) {
        const cause = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        throw new OpcError('READ_FAILED', `Não foi possível ler o arquivo ${filePath}.`, { exitCode: 5, details: { path: filePath }, cause });
      }
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (cause instanceof OpcError) throw cause;
    if (cause.code === 'ENOENT') return fallback;
    throw new OpcError('READ_FAILED', `Não foi possível ler o arquivo ${filePath}.`, { exitCode: 5, details: { path: filePath }, cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new OpcError('INVALID_JSON', `O arquivo ${filePath} não contém JSON válido.`, { exitCode: 2, details: { path: filePath }, cause });
  }
}

function defaultState() {
  return { version: 1, claudeSessions: [], jobs: [] };
}

function normalizeState(raw) {
  return {
    ...defaultState(),
    ...raw,
    version: 1,
    claudeSessions: Array.isArray(raw?.claudeSessions) ? raw.claudeSessions : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs : [],
  };
}

function rebuildJobs(stateDir) {
  const jobsDir = path.join(stateDir, 'jobs');
  let names = [];
  try {
    names = fs.readdirSync(jobsDir).filter((n) => n.endsWith('.json'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return { jobs: [], warnings: [] };
    throw new OpcError('STATE_UNREADABLE', 'Não foi possível ler o estado do workspace.', { exitCode: 5, details: { path: jobsDir }, cause });
  }
  const jobs = [];
  const warnings = [];
  for (const name of names.sort()) {
    const jobPath = path.join(jobsDir, name);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        warnings.push(name);
        continue;
      }
      throw new OpcError('STATE_UNREADABLE', 'Não foi possível ler o estado do workspace.', { exitCode: 5, details: { path: jobPath }, cause });
    }
    if (job && typeof job.id === 'string') jobs.push(job);
  }
  return { jobs, warnings };
}

export function loadState(stateDir) {
  const file = path.join(stateDir, 'state.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1
      || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.claudeSessions)) {
      throw new Error('Invalid state structure');
    }
    return normalizeState(parsed);
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.writeFileSync(backup, raw, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
    const result = rebuildJobs(stateDir);
    const rebuilt = { ...defaultState(), jobs: result.jobs, rebuildWarnings: result.warnings };
    writeFileAtomic(file, rebuilt);
    return rebuilt;
  }
}

export async function updateState(stateDir, mutator) {
  return withLock(path.join(stateDir, 'state.lock'), { timeoutMs: STATE_LOCK_TIMEOUT_MS, purpose: 'state' }, async () => {
    const state = loadState(stateDir);
    const result = await mutator(state);
    const next = normalizeState(result ?? state);
    writeFileAtomic(path.join(stateDir, 'state.json'), next);
    return next;
  });
}

export function listActiveJobs(stateDir) {
  return loadState(stateDir).jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status));
}
