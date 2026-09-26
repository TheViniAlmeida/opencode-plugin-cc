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

export function resolveWorkspaceRoot(cwd) {
  let real;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new UsageError('USAGE', `Diretório não encontrado: ${cwd}`);
  }
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', shell: false });
  if (res.status === 0 && res.stdout.trim()) {
    try {
      return fs.realpathSync.native(res.stdout.trim());
    } catch {
      return real;
    }
  }
  return real;
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
  fs.writeFileSync(tmp, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
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
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names.sort()) {
    const job = readJson(path.join(jobsDir, name), null);
    if (job && typeof job.id === 'string') jobs.push(job);
  }
  return jobs;
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
    return normalizeState(JSON.parse(raw));
  } catch {
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    const rebuilt = { ...defaultState(), jobs: rebuildJobs(stateDir) };
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
