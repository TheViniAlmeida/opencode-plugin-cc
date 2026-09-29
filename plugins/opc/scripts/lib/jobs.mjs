// Job records, worker lifecycle, limits and cancel (spec §9.1–§9.2).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, NotFoundError, OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { redact, redactOutput, redactTurnOutput, redactText, safeOutputText } from './redact.mjs';
import { ACTIVE_JOB_STATUSES, ensurePrivateDir, readJson, updateState, writeFileAtomic } from './state.mjs';
import { tryAcquireLock } from './locks.mjs';
import { identityMatches, isPidAlive, spawnDetached, terminateProcessGroup, exitingWithoutCmdline } from './process.mjs';
import { readServerRecord } from './server.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';

// Single source of truth for the active states is F0 state.mjs (the setup already uses it).
export const ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const GROUP_ROLE = 'group';
export const MAX_TERMINAL_JOBS = 50;
export const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
export const COMPANION_PATH = fileURLToPath(new URL('../opc-companion.mjs', import.meta.url));
// Every kind used by F2a..F4c; the id prefix is derived from the kind (callers never pass an id).
const KIND_PREFIX = Object.freeze({
  task: 'task', review: 'review', 'adversarial-review': 'review', ask: 'ask', plan: 'plan',
  subagent: 'sub', sub: 'sub', cmd: 'cmd', orchestrate: 'orch', orch: 'orch',
  conclave: 'conc', 'conclave-member': 'conc', 'conclave-judge': 'conc', 'stop-gate': 'gate',
});
const JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
const SAFE_JOB_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const JOB_REF_RE = /^[0-9a-z-]+$/;
const SESSION_ID_RE = /^ses[_0-9A-Za-z]+$/;
const QUEUED_WITHOUT_WORKER_MS = 60_000;
const BLOCK_TITLES = new Set(['Saída final']);

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (value) => `${String(value ?? '').slice(0, 12)}…`;

export const isActive = (job) => ACTIVE_STATUSES.includes(job?.status);
export const isTerminal = (job) => TERMINAL_STATUSES.includes(job?.status);
export const jobsDir = (stateDir) => join(stateDir, 'jobs');
function assertJobId(id) {
  if (typeof id !== 'string' || !SAFE_JOB_ID_RE.test(id)) {
    throw new UsageError('INVALID_JOB_ID', `identificador de tarefa inválido "${short(id)}"`);
  }
  return id;
}
const jobPath = (stateDir, id) => join(jobsDir(stateDir), `${assertJobId(id)}.json`);
export const jobLogPath = (stateDir, id) => join(jobsDir(stateDir), `${assertJobId(id)}.log`);
export const workerLogPath = (stateDir, id) => join(jobsDir(stateDir), `${assertJobId(id)}.worker.log`);
const jobInputPath = (stateDir, id) => join(jobsDir(stateDir), `${assertJobId(id)}.input.json`);
const consumingInputPrefix = (id) => `${assertJobId(id)}.input.`;

export function cleanupJobInputFiles(stateDir, id) {
  const dir = jobsDir(stateDir);
  const base = jobInputPath(stateDir, id);
  try { unlinkSync(base); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const prefix = consumingInputPrefix(id);
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.consuming')) continue;
    try { unlinkSync(join(dir, name)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

// The sole unredacted handoff lives in our private job directory, never in the record.
export function consumeJobInput(stateDir, id) {
  const source = jobInputPath(stateDir, id);
  const consuming = join(jobsDir(stateDir), `${assertJobId(id)}.input.${process.pid}-${randomBytes(8).toString('hex')}.consuming`);
  try {
    renameSync(source, consuming);
  } catch (err) {
    if (err.code === 'ENOENT') throw new OpcError('JOB_INPUT_MISSING', 'A entrada privada da tarefa não está disponível.');
    throw err;
  }
  let fd;
  try {
    try {
      if (typeof constants.O_NOFOLLOW !== 'number') {
        throw new OpcError('JOB_INPUT_INVALID', 'A entrada privada da tarefa é inválida.');
      }
      fd = openSync(consuming, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new OpcError('JOB_INPUT_INVALID', 'A entrada privada da tarefa é inválida.');
      }
      const raw = readFileSync(fd, 'utf8');
      try { return JSON.parse(raw); } catch (cause) {
        throw new OpcError('JOB_INPUT_INVALID', 'A entrada privada da tarefa é inválida.', { cause });
      }
    } catch (err) {
      if (err.code === 'ELOOP' || err.code === 'EINVAL') {
        throw new OpcError('JOB_INPUT_INVALID', 'A entrada privada da tarefa é inválida.', { cause: err });
      }
      throw err;
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the input validation/read error */ }
    }
    try { unlinkSync(consuming); } catch { /* best effort for the reserved path */ }
  }
}

function discardJobInput(stateDir, id) {
  cleanupJobInputFiles(stateDir, id);
}

export function newJobId(kind) {
  const prefix = KIND_PREFIX[kind];
  if (!prefix) throw new UsageError('UNKNOWN_KIND', `tipo de tarefa desconhecido "${short(kind)}"`);
  const rand = Array.from(randomBytes(6), (b) => (b % 36).toString(36)).join('');
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function jobDefaults() {
  return {
    title: null, summary: null, workspaceRoot: null, claudeSessionId: null, groupId: null, role: null,
    startedAt: null, completedAt: null, pid: null, pidStartTime: null, serverUrlRef: null,
    sessionID: null, parentSessionID: null, childSessionIDs: [], model: null, attempts: [], agent: null,
    variant: null, permissionProfile: null, pendingRequest: null, errorCode: null, errorClass: null,
    errorType: null, errorMessage: null, cancelRequestedAt: null, request: null, result: null, rendered: null,
  };
}

// Allowlist request metadata: raw prompts/schemas belong only in the consumed input file.
function safeJob(job) {
  if (!job) return job;
  const safe = { ...job };
  if (job.request) {
    const request = job.request;
    safe.request = Object.fromEntries(['kind', 'model', 'modelFull', 'profile', 'profileKind', 'title', 'agent', 'variant', 'sessionID']
      .filter((key) => request[key] !== undefined).map((key) => [key, request[key]]));
    if (request.format) safe.request.format = { type: request.format.type };
    safe.request.bytes = request.bytes ?? Buffer.byteLength(JSON.stringify(request));
    safe.request.textBytes = request.textBytes ?? (request.parts ?? []).reduce((sum, part) => sum + Buffer.byteLength(part.text ?? ''), 0);
    if (request.review) safe.request.review = Object.fromEntries(['variant', 'targetLabel', 'inputMode']
      .filter((key) => request.review[key] !== undefined).map((key) => [key, request.review[key]]));
  }
  const masked = redact(safe);
  for (const field of ['title', 'summary', 'pendingRequest']) {
    if (Object.hasOwn(masked, field)) masked[field] = redactOutput(masked[field]);
  }
  if (masked.request) masked.request = redactOutput(masked.request);
  if (masked.result) masked.result = redactTurnOutput(masked.result);
  if (typeof masked.summary === 'string') masked.summary = masked.summary.slice(0, 200);
  return masked;
}

function writeJob(stateDir, job) {
  writeFileAtomic(jobPath(stateDir, job.id), `${JSON.stringify(safeJob(job), null, 2)}\n`);
  if (isTerminal(job)) discardJobInput(stateDir, job.id);
}

function upsertIndex(state, job) {
  const entry = { id: job.id, kind: job.kind, status: job.status, claudeSessionId: job.claudeSessionId ?? null, groupId: job.groupId ?? null, updatedAt: job.updatedAt };
  state.jobs = [...(state.jobs ?? []).filter((j) => j.id !== job.id), entry];
}

export function readJob(stateDir, id) {
  assertJobId(id);
  if (!JOB_ID_RE.test(id)) return null;
  return safeJob(readJson(jobPath(stateDir, id), null));
}

export function listJobs(stateDir, { claudeSessionId = null, all = false } = {}) {
  let names;
  try {
    names = readdirSync(jobsDir(stateDir));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!JOB_ID_RE.test(id)) continue;
    const job = readJob(stateDir, id);
    if (job?.id === id) jobs.push(job);
  }
  const visible = all || !claudeSessionId ? jobs : jobs.filter((j) => j.claudeSessionId === claudeSessionId);
  return visible.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
}

export function workerMatcher(jobId) {
  return (cmdline = []) => {
    const i = cmdline.indexOf('task-worker');
    return i > 0 && String(cmdline[i - 1]).endsWith('opc-companion.mjs') && cmdline[i + 1] === '--job-id' && cmdline[i + 2] === jobId;
  };
}

function workerLost(job, now = Date.now()) {
  if (!isActive(job) || isGroupMember(job)) return false;
  if (job.pid) return !identityMatches({ pid: job.pid, startTime: job.pidStartTime }, workerMatcher(job.id));
  return job.status === 'queued' && now - Date.parse(job.createdAt) > QUEUED_WITHOUT_WORKER_MS;
}

const lostPatch = () => ({
  status: 'failed', phase: 'failed', completedAt: nowIso(), pendingRequest: null, errorCode: 'worker_lost',
  errorClass: 'fatal', errorType: 'WorkerLost', errorMessage: 'o processo da tarefa terminou sem concluir o trabalho',
});

function pruneTerminal(stateDir, state, jobs) {
  const ids = new Set(selectJobsToPrune(jobs, MAX_TERMINAL_JOBS));
  if (ids.size === 0) return;
  for (const id of ids) {
    cleanupJobInputFiles(stateDir, id);
    for (const file of [jobPath(stateDir, id), jobLogPath(stateDir, id), workerLogPath(stateDir, id)]) rmSync(file, { force: true });
  }
  state.jobs = (state.jobs ?? []).filter((entry) => !ids.has(entry.id));
}

export async function createJob(stateDir, fields, { maxActive = 8, updateStateFn = updateState, writeInputFn = writeFileAtomic } = {}) {
  ensurePrivateDir(jobsDir(stateDir));
  let created = null;
  let inputWritten = false;
  try {
    await updateStateFn(stateDir, (state) => {
      const jobs = listJobs(stateDir, { all: true });
      const lostGroups = new Set();
      for (const job of jobs) {
        if (!workerLost(job)) continue;
        Object.assign(job, lostPatch(), { updatedAt: nowIso() });
        writeJob(stateDir, job);
        upsertIndex(state, job);
        if (job.role === GROUP_ROLE) lostGroups.add(job.id);
      }
      for (const member of jobs) {
        if (!lostGroups.has(member.groupId) || !isActive(member)) continue;
        Object.assign(member, lostPatch(), { updatedAt: nowIso() });
        writeJob(stateDir, member);
        upsertIndex(state, member);
      }
      const active = jobs.filter(isActive);
      const counted = jobs.filter(countsTowardLimit);
      if (!fields.groupId && counted.length >= maxActive) {
        throw new UsageError('TOO_MANY_JOBS', `jobs.maxActive (${maxActive}) atingido; tarefas ativas:\n${counted.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
          details: { active: counted.map((j) => ({ id: j.id, kind: j.kind, status: j.status })) },
        });
      }
      if (fields.sessionID) {
        const busy = active.find((j) => j.sessionID === fields.sessionID);
        if (busy) {
          throw new UsageError('SESSION_BUSY', `a sessão ${fields.sessionID} já tem uma tarefa ativa (${busy.id}); aguarde ou execute /opc:cancel ${busy.id}`, { details: { jobId: busy.id } });
        }
      }
      const id = newJobId(fields.kind);
      const now = nowIso();
      created = { ...jobDefaults(), ...fields, id, status: 'queued', phase: 'queued', createdAt: now, updatedAt: now, logFile: jobLogPath(stateDir, id) };
      writeJob(stateDir, created);
      if (created.request) {
        try {
          writeInputFn(jobInputPath(stateDir, id), `${JSON.stringify(created.request)}\n`);
        } catch (cause) {
          const message = 'Não foi possível gravar a entrada privada da tarefa.';
          created = { ...created, status: 'failed', phase: 'failed', completedAt: nowIso(), errorCode: 'JOB_INPUT_WRITE_FAILED', errorClass: 'fatal', errorType: 'JobInputWriteFailed', errorMessage: message };
          writeJob(stateDir, created);
          upsertIndex(state, created);
          try { unlinkSync(jobInputPath(stateDir, id)); } catch { /* best effort for this exact input path */ }
          throw new OpcError('JOB_INPUT_WRITE_FAILED', message, { exitCode: ExitCode.JOB_FAILED, cause });
        }
        inputWritten = true;
      }
      upsertIndex(state, created);
      pruneTerminal(stateDir, state, jobs);
      return state;
    });
  } catch (err) {
    if (inputWritten && created?.request) {
      try { unlinkSync(jobInputPath(stateDir, created.id)); } catch { /* best effort for this exact input path */ }
    }
    throw err;
  }
  return safeJob(created);
}

export async function updateJob(stateDir, id, patch) {
  let updated = null;
  await updateState(stateDir, (state) => {
    const job = readJob(stateDir, id);
    if (!job) throw new NotFoundError('NOT_FOUND', `tarefa ${id} não encontrada`);
    if (isTerminal(job)) {
      updated = job;
      return state;
    }
    const changes = { ...((typeof patch === 'function' ? patch(job) : patch) ?? {}) };
    updated = { ...job, ...changes, id: job.id, updatedAt: nowIso() };
    writeJob(stateDir, updated);
    upsertIndex(state, updated);
    return state;
  });
  return safeJob(updated);
}

// Idempotently remove permission/question ids from a job and resume it when clear.
export async function clearJobRequests(stateDir, id, requestIds) {
  const ids = new Set(requestIds);
  return updateJob(stateDir, id, (job) => {
    const pending = job.pendingRequest ?? [];
    const remaining = pending.filter((request) => !ids.has(request.id));
    if (remaining.length === pending.length) return {};
    if (job.status === 'waiting_permission' && remaining.length === 0) {
      return { pendingRequest: null, status: 'running', phase: 'running' };
    }
    return { pendingRequest: remaining.length ? remaining : null };
  });
}

export async function reconcileJob(stateDir, job) {
  if (!workerLost(job)) return job;
  const lost = await updateJob(stateDir, job.id, lostPatch());
  if (job.role === GROUP_ROLE) {
    for (const member of listJobs(stateDir, { all: true })) {
      if (member.groupId === job.id && isActive(member)) await updateJob(stateDir, member.id, lostPatch());
    }
  }
  return lost;
}

export function resolveJobRef(stateDir, ref, { claudeSessionId = null, activeOnly = false } = {}) {
  const pool = listJobs(stateDir, { all: true }).filter((j) => !activeOnly || isActive(j));
  if (ref) {
    if (!JOB_REF_RE.test(ref)) throw new UsageError('INVALID_JOB_ID', `identificador de tarefa inválido "${short(ref)}"`);
    const exact = pool.find((j) => j.id === ref);
    if (exact) return exact;
    const matches = pool.filter((j) => j.id.startsWith(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new UsageError('AMBIGUOUS_JOB', `a referência "${short(ref)}" corresponde a ${matches.length} tarefas; informe um identificador mais longo`);
    throw new NotFoundError('NOT_FOUND', activeOnly ? `nenhuma tarefa ativa corresponde a "${short(ref)}"` : `nenhuma tarefa corresponde a "${short(ref)}" (consulte /opc:status)`);
  }
  const scoped = topLevelJobs(pool).filter((j) => isActive(j) && (!claudeSessionId || j.claudeSessionId === claudeSessionId));
  if (scoped.length === 1) return scoped[0];
  if (scoped.length > 1) {
    throw new UsageError('MULTIPLE_ACTIVE_JOBS', `há várias tarefas ativas; informe um identificador:\n${scoped.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
      details: { active: scoped.map((j) => j.id) },
    });
  }
  throw new NotFoundError('NO_ACTIVE_JOB', claudeSessionId ? 'nenhuma tarefa opc ativa nesta sessão do Claude' : 'nenhuma tarefa opc ativa');
}

export function findResumeCandidate(stateDir, { kind, claudeSessionId }) {
  if (!claudeSessionId) return null;
  return listJobs(stateDir, { claudeSessionId })
    .filter((j) => j.kind === kind && j.sessionID && isTerminal(j))
    .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? ''))
      || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
}

export function groupStatus(members) {
  if (members.some((m) => m.status === 'waiting_permission')) return 'waiting_permission';
  if (members.some(isActive)) return 'running';
  if (members.length > 0 && members.every((m) => m.status === 'cancelled')) return 'cancelled';
  if (members.some((m) => m.status === 'completed')) return 'completed';
  return 'failed';
}

export function capLogFile(file, limit = LOG_LIMIT_BYTES) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= limit) return;
  const keep = Math.floor(limit * 0.8);
  const buffer = Buffer.alloc(keep);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString('utf8');
  const newline = text.indexOf('\n');
  if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1);
  writeFileAtomic(file, `[${nowIso()}] [registro reduzido: mantidos os últimos ${keep} bytes]\n${text}`);
}

export function appendJobLog(stateDir, id, line, { modelDerived = false } = {}) {
  const text = (modelDerived ? safeOutputText : redactText)(String(line ?? '')).replace(/\s+$/, '');
  if (!text) return;
  ensurePrivateDir(jobsDir(stateDir));
  const file = jobLogPath(stateDir, id);
  appendFileSync(file, `[${nowIso()}] ${text}\n`, { mode: 0o600 });
  capLogFile(file);
}

export function readJobProgress(stateDir, id, maxLines = 4) {
  assertJobId(id);
  let text;
  try {
    text = readFileTail(jobLogPath(stateDir, id), 64 * 1024);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('['))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line && !BLOCK_TITLES.has(line))
    .slice(-maxLines);
}

function readFileTail(file, bytes) {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

export function acquireSessionLock(stateDir, sessionID) {
  if (!SESSION_ID_RE.test(String(sessionID))) throw new UsageError('INVALID_SESSION_ID', `identificador de sessão inválido "${short(sessionID)}"`);
  return tryAcquireLock(join(stateDir, `session-${sessionID}.lock`), { purpose: `tarefa na sessão ${sessionID}` });
}

export function serverContext(ctx) {
  return {
    stateDir: ctx.stateDir,
    workspaceRoot: ctx.workspaceRoot,
    config: ctx.config,
    env: ctx.env,
    hasActiveJobs: () => listJobs(ctx.stateDir, { all: true }).some(isActive),
  };
}

// Recursion guard (spec §9.1): every command that creates a job calls this before connecting.
export function assertNotInsideServer(env) {
  if (env?.OPC_INSIDE_SERVER === '1') {
    throw new PolicyError('INSIDE_SERVER', 'opc não inicia tarefas dentro do servidor OpenCode (OPC_INSIDE_SERVER=1): a delegação não pode recursar');
  }
}

export function existingServerApi(ctx) {
  const env = ctx.env ?? {};
  let baseUrl = env.OPC_SERVER_URL || null;
  let password = env.OPC_SERVER_PASSWORD || null;
  if (!baseUrl) {
    const record = readServerRecord(ctx.stateDir);
    if (!record?.url) return null;
    baseUrl = record.url;
    password = record.password;
  }
  return createApi(createClient({ baseUrl, password, directory: ctx.workspaceRoot, requestTimeoutMs: 5000 }));
}

export async function spawnWorker(ctx, jobId, { spawn: start = spawnDetached } = {}) {
  ensurePrivateDir(jobsDir(ctx.stateDir));
  let pid, startTime;
  try {
    ({ pid, startTime } = await start(process.execPath, [COMPANION_PATH, 'task-worker', '--job-id', jobId], {
      cwd: ctx.workspaceRoot,
      env: { ...ctx.env, OPC_DATA_DIR: ctx.dataDir },
      logFile: workerLogPath(ctx.stateDir, jobId),
    }));
  } catch (cause) {
    const message = 'Não foi possível iniciar o worker da tarefa.';
    await updateJob(ctx.stateDir, jobId, {
      status: 'failed', phase: 'failed', completedAt: nowIso(), pendingRequest: null,
      errorCode: 'WORKER_SPAWN_FAILED', errorClass: 'fatal', errorType: 'WorkerSpawnFailed', errorMessage: message,
    });
    discardJobInput(ctx.stateDir, jobId);
    throw new OpcError('WORKER_SPAWN_FAILED', message, { exitCode: ExitCode.JOB_FAILED, cause });
  }
  return updateJob(ctx.stateDir, jobId, (job) => (job.pid ? {} : { pid, pidStartTime: startTime }));
}

function streamLog(file, offset, onLog) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return offset;
  }
  if (size < offset) offset = 0;
  if (size === offset) return offset;
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return offset;
  for (const line of text.slice(0, lastNewline).split('\n')) if (line) onLog(line);
  return offset + Buffer.byteLength(text.slice(0, lastNewline + 1));
}

export async function waitForJob(ctx, id, { waitTimeoutMs = null, pollMs = 500, onLog = null } = {}) {
  const deadline = waitTimeoutMs == null ? Infinity : performance.now() + waitTimeoutMs;
  const logFile = jobLogPath(ctx.stateDir, id);
  let offset = 0;
  for (;;) {
    if (onLog) offset = streamLog(logFile, offset, onLog);
    let job = readJob(ctx.stateDir, id);
    if (!job) throw new NotFoundError('NOT_FOUND', `tarefa ${id} não encontrada`);
    job = await reconcileJob(ctx.stateDir, job);
    if (!isActive(job) || (job.status === 'waiting_permission' && job.pendingRequest?.length)) {
      if (onLog) streamLog(logFile, offset, onLog);
      return job;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new OpcError('WAIT_TIMEOUT', `a tarefa ${id} continua ${job.status} (fase ${job.phase}); ela segue em execução. Acompanhe com: /opc:status ${id} --wait`, {
        exitCode: ExitCode.WAIT_TIMEOUT,
        details: { jobId: id, status: job.status, phase: job.phase },
      });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

// ---- F2b: turn-job adapter and server.lock coordination ----
import { withLock } from './locks.mjs';
import { buildPermissionRules, parseProfile } from './policy.mjs';
import { newMessageId } from './runner.mjs';

export function serverLockPath(stateDir) {
  return join(stateDir, 'server.lock');
}

export function serverLockTimeoutMs(config) {
  return 4 * (config?.server?.bootTimeoutSec ?? 60) * 1000;
}

export async function withServerLock(ctx, fn, { purpose = 'server-coordination' } = {}) {
  return withLock(serverLockPath(ctx.stateDir), { timeoutMs: serverLockTimeoutMs(ctx.config), purpose }, fn);
}

export function turnJobRequest({ kind, profile, prompt, model, modelFull, variant = null, agent = null, format = null,
  timeoutMs, title, config = {}, sessionID = null, extra = {} }) {
  const policy = config.policy ?? {};
  const rules = buildPermissionRules(profile, { policy, permissionProfiles: config.permissionProfiles ?? {}, deniedAgentGlobs: policy.agents?.deny ?? [] });
  const profileKind = parseProfile(profile).kind;
  const controls = {
    kind, profile, profileKind, title,
    ...(sessionID ? { sessionID } : { newSession: { title, permission: rules } }),
    childPermission: profileKind === 'read-only' ? null : rules,
    parts: [{ type: 'text', text: prompt }],
    model: { providerID: model.providerID, modelID: model.modelID },
    modelFull, variant: variant ?? null, agent: agent ?? null, format: format ?? null,
    messageID: newMessageId(), timeoutMs,
    fallbackCfg: config.routing?.fallback ?? {},
    permissionTimeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
  };
  const reserved = new Set([...Object.keys(controls), 'sessionID', 'permission']);
  for (const key of Object.keys(extra ?? {})) {
    if (reserved.has(key)) throw new UsageError('INTERNAL_FIELD_COLLISION', `campo interno do adaptador não pode ser sobrescrito: ${key}`);
  }
  return { ...extra, ...controls };
}

export async function submitTurnJob(ctx, { kind, title, summary, request, claudeSessionId = ctx.claudeSessionId ?? null, fields = {}, queuedLog = null }) {
  for (const key of ['kind', 'request', 'id']) {
    if (Object.hasOwn(fields ?? {}, key)) throw new UsageError('INTERNAL_FIELD_COLLISION', `campo interno do adaptador não pode ser sobrescrito: ${key}`);
  }
  const job = await withServerLock(ctx, () => createJob(ctx.stateDir, {
    ...fields,
    kind, title, summary, workspaceRoot: ctx.workspaceRoot, claudeSessionId,
    sessionID: request.sessionID ?? null,
    model: request.modelFull ?? null, agent: request.agent ?? null, variant: request.variant ?? null,
    permissionProfile: request.profile ?? null, request,
  }, { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: `register-job:${kind}` });
  if (queuedLog) appendJobLog(ctx.stateDir, job.id, queuedLog);
  await spawnWorker(ctx, job.id);
  return requirePersistedJob(ctx.stateDir, job.id);
}

export function requirePersistedJob(stateDir, id) {
  const persisted = readJob(stateDir, id);
  if (!persisted) throw new OpcError('JOB_RECORD_MISSING', `O registro da tarefa ${id} desapareceu após iniciar o worker.`, { exitCode: ExitCode.CONNECTION, details: { jobId: id } });
  return persisted;
}

export function isJobLive(job, { now = Date.now() } = {}) {
  return isActive(job) && !workerLost(job, now);
}

export function liveActiveJobs(stateDir, { claudeSessionId = null, now = Date.now() } = {}) {
  return listJobs(stateDir, { all: true }).filter(
    (job) => (claudeSessionId ? job.claudeSessionId === claudeSessionId : true) && isJobLive(job, { now }),
  );
}

async function waitSessionIdle(api, sessionID, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    const statuses = await api.sessionStatus();
    const own = statuses?.[sessionID];
    if (!own || own.type === 'idle') return true;
    await sleep(250);
  }
  return false;
}

async function waitWorkerExit(expected, matcher, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    if (!identityMatches(expected, matcher)) return true;
    await sleep(100);
  }
  return !identityMatches(expected, matcher);
}

export async function cancelJob(ctx, id, { api = undefined, idleWaitMs = 10000, exitWaitMs = 2000, graceMs = 3000 } = {}) {
  assertJobId(id);
  const current = readJob(ctx.stateDir, id);
  if (!current) throw new NotFoundError('NOT_FOUND', `a tarefa ${id} não foi encontrada`);
  if (!isActive(current)) throw new UsageError('NOT_ACTIVE', `a tarefa ${id} já está ${current.status}`);
  const job = await updateJob(ctx.stateDir, id, { cancelRequestedAt: nowIso() });
  const report = { jobId: id, aborted: false, idle: false, worker: 'not-running' };
  if (!isActive(job)) {
    report.status = job.status;
    return { job, report };
  }
  const client = api === undefined ? existingServerApi(ctx) : api;
  if (client && job.sessionID) {
    try {
      for (const sessionID of [job.sessionID, ...(job.childSessionIDs ?? [])]) {
        if (await client.abort(sessionID) === false) throw new Error(`o servidor recusou o cancelamento da sessão ${sessionID}`);
      }
      report.aborted = true;
      report.idle = await waitSessionIdle(client, job.sessionID, idleWaitMs);
      if (!report.idle) throw new Error('a sessão não ficou ociosa dentro do prazo');
    } catch (err) {
      const message = short(redactText(err?.message ?? String(err)));
      appendJobLog(ctx.stateDir, id, `falha ao solicitar cancelamento: ${message}`);
      const latest = readJob(ctx.stateDir, id);
      return { ok: false, code: 'CANCEL_FAILED', reason: message, job: latest, report };
    }
  }
  if (job.pid) {
    const expected = { pid: job.pid, startTime: job.pidStartTime };
    const matcher = workerMatcher(id);
    if (!identityMatches(expected, matcher)) {
      if (await exitingWithoutCmdline(expected)) report.worker = 'exited';
      else report.worker = isPidAlive(job.pid) ? 'identity-mismatch' : 'not-running';
    } else if (await waitWorkerExit(expected, matcher, exitWaitMs)) {
      report.worker = 'exited';
    } else {
      report.worker = await terminateProcessGroup(expected, matcher, { graceMs });
    }
  }
  const final = await updateJob(ctx.stateDir, id, {
    status: 'cancelled', phase: 'cancelled', completedAt: nowIso(), pendingRequest: null,
    errorCode: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorMessage: 'Cancelada pelo usuário.',
  });
  if (final.status === 'cancelled') appendJobLog(ctx.stateDir, id, 'Cancelada pelo usuário.');
  report.status = final.status;
  return { job: final, report };
}

export function isGroupMember(job) {
  return Boolean(job && job.groupId);
}

export function topLevelJobs(jobs) {
  return jobs.filter((job) => !isGroupMember(job));
}

export function countsTowardLimit(job) {
  return ACTIVE_STATUSES.includes(job.status) && !isGroupMember(job);
}

export function selectJobsToPrune(jobs, keep = 50) {
  const hasActiveMember = (group) => jobs.some((m) => m.groupId === group.id && ACTIVE_STATUSES.includes(m.status));
  const terminalTop = topLevelJobs(jobs)
    .filter((j) => TERMINAL_STATUSES.includes(j.status) && !(j.role === GROUP_ROLE && hasActiveMember(j)))
    .sort((a, b) => String(b.completedAt ?? b.updatedAt ?? '').localeCompare(String(a.completedAt ?? a.updatedAt ?? '')));
  const ids = new Set(terminalTop.slice(keep).map((j) => j.id));
  for (const j of jobs) if (j.groupId && ids.has(j.groupId)) ids.add(j.id);
  return [...ids];
}

export async function addGroupMember(stateDir, groupId, fields = {}) {
  const group = readJob(stateDir, groupId);
  if (!group || group.role !== GROUP_ROLE) throw new NotFoundError('NOT_FOUND', `grupo ${groupId} não encontrado`);
  let member = await createJob(stateDir, {
    workspaceRoot: group.workspaceRoot ?? null,
    claudeSessionId: group.claudeSessionId ?? null,
    ...fields,
    kind: fields.kind ?? group.kind,
    groupId,
    role: fields.role ?? `member:${(group.memberIds ?? []).length + 1}`,
  });
  if (fields.status && fields.status !== member.status) {
    member = await updateJob(stateDir, member.id, { status: fields.status, phase: fields.phase ?? fields.status });
  }
  await updateJob(stateDir, groupId, (g) => ({ memberIds: [...(g.memberIds ?? []), member.id] }));
  return member;
}

export async function createGroup(stateDir, groupFields, memberFieldsList, { maxActive = 8 } = {}) {
  const group = await createJob(stateDir, { ...groupFields, role: GROUP_ROLE, groupId: null, memberIds: [] }, { maxActive });
  const members = [];
  try {
    for (const fields of memberFieldsList) members.push(await addGroupMember(stateDir, group.id, fields));
  } catch (err) {
    const failed = { status: 'failed', errorCode: 'group_create_failed', errorMessage: 'Não foi possível criar o grupo de tarefas.', completedAt: new Date().toISOString() };
    for (const m of members) await updateJob(stateDir, m.id, failed);
    await updateJob(stateDir, group.id, failed);
    throw err;
  }
  return { group: readJob(stateDir, group.id), members };
}

export function listGroupMembers(stateDir, groupId) {
  const group = readJob(stateDir, groupId);
  const ids = group?.memberIds ?? listJobs(stateDir, { all: true }).filter((j) => j.groupId === groupId).map((j) => j.id);
  return ids.map((id) => readJob(stateDir, id)).filter(Boolean);
}

export function aggregateGroup(members) {
  const counts = { queued: 0, running: 0, waiting_permission: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const m of members) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const total = members.length;
  const done = counts.completed + counts.failed + counts.cancelled;
  const status = total > 0 && counts.queued === total ? 'queued' : groupStatus(members);
  const warnings = status === 'completed' && done > counts.completed ? [`${counts.failed} falharam, ${counts.cancelled} canceladas`] : [];
  return { status, counts, total, done, phase: `${done}/${total} concluídas`, warnings };
}

function memberSummary(m) {
  return {
    id: m.id, role: m.role, agent: m.agent ?? null, model: m.model ?? null, status: m.status,
    sessionID: m.sessionID ?? null, mechanism: m.result?.mechanism ?? null, errorMessage: m.errorMessage ?? null,
  };
}

// decorate(group, members) → extra fields written in the same update (a terminal job is frozen afterwards).
export async function refreshGroup(stateDir, groupId, { final = false, decorate = null } = {}) {
  const group = readJob(stateDir, groupId);
  if (!group || group.status === 'cancelled') return group;
  const members = listGroupMembers(stateDir, groupId);
  const agg = aggregateGroup(members);
  let status = agg.status;
  if (status === 'queued' && group.status === 'running') status = 'running';
  if (!final && TERMINAL_STATUSES.includes(status)) status = 'running';
  const warnings = [...agg.warnings];
  if (final && ACTIVE_STATUSES.includes(status)) {
    status = 'failed';
    warnings.push('O coordenador terminou com membros ainda ativos.');
  }
  const pending = members
    .filter((m) => m.status === 'waiting_permission')
    .flatMap((m) => (m.pendingRequest ?? []).map((req) => ({ ...req, memberId: m.id })));
  const patch = {
    status,
    phase: agg.phase,
    pendingRequest: pending.length ? pending : null,
    result: { counts: agg.counts, warnings, members: members.map(memberSummary) },
  };
  if (TERMINAL_STATUSES.includes(status)) patch.completedAt = group.completedAt ?? new Date().toISOString();
  if (decorate) Object.assign(patch, decorate({ ...group, ...patch }, members));
  return updateJob(stateDir, groupId, patch);
}

export async function cancelGroup(ctx, groupId) {
  const group = readJob(ctx.stateDir, groupId);
  const active = listGroupMembers(ctx.stateDir, groupId).filter((m) => ACTIVE_STATUSES.includes(m.status));
  const results = await Promise.all(active.map(async (member) => {
    try {
      const result = await cancelJob(ctx, member.id);
      if (result?.ok === false) {
        const reason = redactText(result.reason ?? result.code ?? 'cancelamento recusado');
        appendJobLog(ctx.stateDir, groupId, `[opc] cancel ${member.id} falhou: ${reason}`);
        return { id: member.id, ok: false };
      }
      return { id: member.id, ok: true };
    } catch (err) {
      const reason = redactText(err?.message ?? String(err));
      appendJobLog(ctx.stateDir, groupId, `[opc] cancel ${member.id} falhou: ${reason}`);
      return { id: member.id, ok: false };
    }
  }));
  const cancelledMembers = results.filter((result) => result.ok).map((result) => result.id);
  const failedMembers = results.filter((result) => !result.ok).map((result) => result.id);
  let cancelled = group;
  if (failedMembers.length === 0 && ACTIVE_STATUSES.includes(group.status)) cancelled = await cancelJob(ctx, groupId);
  return { group: readJob(ctx.stateDir, groupId) ?? cancelled, cancelledMembers, failedMembers };
}

export async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const laneCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}
