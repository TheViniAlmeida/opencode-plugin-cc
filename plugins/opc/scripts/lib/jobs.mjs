// Job records, worker lifecycle, limits and cancel (spec §9.1–§9.2).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode, NotFoundError, OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { redact, redactText } from './redact.mjs';
import { ACTIVE_JOB_STATUSES, ensurePrivateDir, readJson, updateState, writeFileAtomic } from './state.mjs';
import { tryAcquireLock } from './locks.mjs';
import { identityMatches, isPidAlive, spawnDetached, terminateProcessGroup } from './process.mjs';
import { readServerRecord } from './server.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';

// Single source of truth for the active states is F0 state.mjs (the setup already uses it).
export const ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
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
      fd = openSync(consuming, constants.O_RDONLY | constants.O_NOFOLLOW);
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

function writeJob(stateDir, job) {
  writeFileAtomic(jobPath(stateDir, job.id), `${JSON.stringify(redact(job), null, 2)}\n`);
  if (isTerminal(job)) discardJobInput(stateDir, job.id);
}

function upsertIndex(state, job) {
  const entry = { id: job.id, kind: job.kind, status: job.status, claudeSessionId: job.claudeSessionId ?? null, groupId: job.groupId ?? null, updatedAt: job.updatedAt };
  state.jobs = [...(state.jobs ?? []).filter((j) => j.id !== job.id), entry];
}

export function readJob(stateDir, id) {
  assertJobId(id);
  if (!JOB_ID_RE.test(id)) return null;
  return readJson(jobPath(stateDir, id), null);
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
    const job = readJson(jobPath(stateDir, id), null);
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
  if (!isActive(job)) return false;
  if (job.pid) return !identityMatches({ pid: job.pid, startTime: job.pidStartTime }, workerMatcher(job.id));
  return job.status === 'queued' && now - Date.parse(job.createdAt) > QUEUED_WITHOUT_WORKER_MS;
}

const lostPatch = () => ({
  status: 'failed', phase: 'failed', completedAt: nowIso(), pendingRequest: null, errorCode: 'worker_lost',
  errorClass: 'fatal', errorType: 'WorkerLost', errorMessage: 'o processo da tarefa terminou sem concluir o trabalho',
});

function pruneTerminal(stateDir, state, jobs) {
  const topLevel = jobs.filter((j) => !j.groupId || j.groupId === j.id);
  const terminal = topLevel.filter((j) => isTerminal(j) && !jobs.some((m) => m.groupId === j.id && isActive(m)));
  terminal.sort((a, b) => String(b.completedAt ?? b.updatedAt).localeCompare(String(a.completedAt ?? a.updatedAt)));
  const doomed = terminal.slice(MAX_TERMINAL_JOBS);
  if (doomed.length === 0) return;
  const ids = new Set();
  for (const job of doomed) {
    ids.add(job.id);
    for (const member of jobs) if (member.groupId === job.id) ids.add(member.id);
  }
  for (const id of ids) {
    cleanupJobInputFiles(stateDir, id);
    for (const file of [jobPath(stateDir, id), jobLogPath(stateDir, id), workerLogPath(stateDir, id)]) rmSync(file, { force: true });
  }
  state.jobs = (state.jobs ?? []).filter((entry) => !ids.has(entry.id));
}

export async function createJob(stateDir, fields, { maxActive = 8, updateStateFn = updateState } = {}) {
  ensurePrivateDir(jobsDir(stateDir));
  let created = null;
  let inputWritten = false;
  try {
    await updateStateFn(stateDir, (state) => {
      const jobs = listJobs(stateDir, { all: true });
      for (const job of jobs) {
        if (!workerLost(job)) continue;
        Object.assign(job, lostPatch(), { updatedAt: nowIso() });
        writeJob(stateDir, job);
        upsertIndex(state, job);
      }
      const active = jobs.filter(isActive);
      if (active.length >= maxActive) {
        throw new UsageError('TOO_MANY_JOBS', `jobs.maxActive (${maxActive}) atingido; tarefas ativas:\n${active.map((j) => `- ${j.id} (${j.kind}, ${j.status})`).join('\n')}`, {
          details: { active: active.map((j) => ({ id: j.id, kind: j.kind, status: j.status })) },
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
        writeFileAtomic(jobInputPath(stateDir, id), `${JSON.stringify(created.request)}\n`);
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
  return created;
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
  return updated;
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
  return updateJob(stateDir, job.id, lostPatch());
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
  const scoped = pool.filter((j) => isActive(j) && (!claudeSessionId || j.claudeSessionId === claudeSessionId));
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

export function appendJobLog(stateDir, id, line) {
  const text = redactText(String(line ?? '')).replace(/\s+$/, '');
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
      report.worker = isPidAlive(job.pid) ? 'identity-mismatch' : 'not-running';
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
