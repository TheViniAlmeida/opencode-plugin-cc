// Internal subcommand: runs one job's turn in a detached process (spec §9.1). Users never call it.
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, NotFoundError, OpcError, UsageError } from '../lib/opc-error.mjs';
import { ensureServer } from '../lib/server.mjs';
import { createClient } from '../lib/http.mjs';
import { createApi } from '../lib/api.mjs';
import { EventHub } from '../lib/sse.mjs';
import { runTurn } from '../lib/runner.mjs';
import { requiresUser } from '../lib/policy.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { redact } from '../lib/redact.mjs';
import { acquireSessionLock, appendJobLog, readJob, serverContext, updateJob } from '../lib/jobs.mjs';

const FINAL_LOG_LIMIT = 64 * 1024;
const METADATA_LIMIT = 4000;
const nowIso = () => new Date().toISOString();

function trimMetadata(metadata) {
  const safe = redact(metadata ?? {});
  return JSON.stringify(safe).length > METADATA_LIMIT ? { truncated: true } : safe;
}

export function createSerialUpdater(stateDir, jobId, { writeJob: write = updateJob } = {}) {
  let chain = Promise.resolve();
  let firstFailure = null;
  return {
    update(patch) {
      const next = chain.then(() => write(stateDir, jobId, patch));
      chain = next.catch((err) => { firstFailure ??= err; });
      return next;
    },
    async flush() {
      await chain;
      if (firstFailure) throw firstFailure;
    },
  };
}

export function queueProgressUpdate(jobUpdates, patch, log) {
  return jobUpdates.update(patch).catch((err) => {
    const detail = redact(err);
    log(`falha ao salvar o progresso da tarefa: ${detail?.message ?? String(detail)}`);
  });
}

export function createRequestBridge({ update, api, profileKind, policy = {}, timeoutMs = 600000, log = () => {} }) {
  const timers = new Map();
  const autoReject = profileKind === 'read-only';
  const clearTimer = (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const addPending = (entry) => update((job) => ({
    status: 'waiting_permission',
    phase: 'waiting_permission',
    pendingRequest: [...(job.pendingRequest ?? []).filter((r) => r.id !== entry.id), entry],
  }));
  const removePending = (id) => update((job) => {
    const remaining = (job.pendingRequest ?? []).filter((r) => r.id !== id);
    if (job.status !== 'waiting_permission') return { pendingRequest: remaining.length ? remaining : null };
    return remaining.length ? { pendingRequest: remaining } : { pendingRequest: null, status: 'running', phase: 'running' };
  });
  const arm = (id, onTimeout) => {
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      log(`sem resposta para ${id} em ${Math.round(timeoutMs / 1000)} s; recusando`);
      onTimeout().catch((err) => log(`falha ao recusar automaticamente ${id}: ${redact(err).message}`));
    }, timeoutMs));
  };
  return {
    async onPermission(req) {
      if (autoReject) {
        log(`permissão ${req.id} (${req.permission}) recusada automaticamente: perfil somente leitura`);
        await api.replyPermission(req.id, { reply: 'reject', message: 'opc: perfil somente leitura; solicitação recusada' });
        return;
      }
      await addPending({
        type: 'permission', id: req.id, sessionID: req.sessionID, permission: req.permission,
        patterns: req.patterns ?? [], metadata: trimMetadata(req.metadata), always: req.always ?? [],
        requiresUser: requiresUser(req, policy), askedAt: nowIso(),
      });
      log(`aguardando decisão sobre ${req.id} (${req.permission})`);
      arm(req.id, () => api.replyPermission(req.id, { reply: 'reject', message: 'opc: nenhum aprovador disponível' }));
    },
    async onQuestion(req) {
      if (autoReject) {
        log(`pergunta ${req.id} recusada automaticamente: perfil somente leitura`);
        await api.rejectQuestion(req.id);
        return;
      }
      await addPending({ type: 'question', id: req.id, sessionID: req.sessionID, questions: req.questions ?? [], askedAt: nowIso() });
      log(`aguardando resposta para ${req.id}`);
      arm(req.id, () => api.rejectQuestion(req.id));
    },
    async onResolved({ requestID, outcome }) {
      clearTimer(requestID);
      log(`solicitação ${requestID} resolvida: ${outcome}`);
      await removePending(requestID);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

function workerErrorCode(err) {
  if (err instanceof ConnectionError) return 'server_unavailable';
  if (err instanceof OpcError) return String(err.code).toLowerCase();
  return 'worker_error';
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, { flags: { 'job-id': { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' } } });
  const jobId = flags['job-id'];
  if (!jobId) throw new UsageError('USAGE', 'task-worker exige --job-id');
  const stored = readJob(ctx.stateDir, jobId);
  if (!stored?.request) throw new NotFoundError('NOT_FOUND', `a tarefa ${jobId} não tem uma solicitação salva`);
  const request = stored.request;
  const log = (line) => appendJobLog(ctx.stateDir, jobId, line);
  const jobUpdates = createSerialUpdater(ctx.stateDir, jobId);
  const identity = getProcessIdentity(process.pid);
  const startedAt = nowIso();
  await jobUpdates.update({ status: 'running', phase: 'starting', startedAt, pid: process.pid, pidStartTime: identity?.startTime ?? null });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  let hub = null;
  let bridge = null;
  let releaseSession = null;
  let exitCode = 0;
  try {
    if (readJob(ctx.stateDir, jobId)?.cancelRequestedAt) controller.abort();
    if (request.sessionID) {
      releaseSession = acquireSessionLock(ctx.stateDir, request.sessionID);
      if (!releaseSession) throw new OpcError('SESSION_BUSY', `a sessão ${request.sessionID} está bloqueada por outra tarefa`, { exitCode: 2 });
    }
    const sctx = serverContext(ctx);
    const server = await ensureServer(sctx);
    const client = createClient({
      baseUrl: server.url,
      password: server.password,
      directory: ctx.workspaceRoot,
      requestTimeoutMs: (ctx.config?.server?.requestTimeoutSec ?? 30) * 1000,
    });
    const api = createApi(client);
    hub = new EventHub({ client });
    await hub.start();
    bridge = createRequestBridge({
      update: (patch) => jobUpdates.update(patch),
      api,
      profileKind: request.profileKind,
      policy: ctx.config?.policy ?? {},
      timeoutMs: request.permissionTimeoutMs ?? 600000,
      log,
    });
    let lastPhase = null;
    const childIDs = new Set(stored.childSessionIDs ?? []);
    const result = await runTurn({
      api,
      hub,
      request,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.message) log(event.message);
        const patch = {};
        if (event.sessionID) patch.sessionID = event.sessionID;
        if (event.childSessionID && !childIDs.has(event.childSessionID)) {
          childIDs.add(event.childSessionID);
          patch.childSessionIDs = [...childIDs];
        }
        if (event.phase && event.phase !== lastPhase) {
          lastPhase = event.phase;
          patch.phase = event.phase;
        }
        if (Object.keys(patch).length === 0) return;
        void queueProgressUpdate(jobUpdates, (job) => (job.status === 'waiting_permission' ? { ...patch, phase: job.phase } : patch), log);
      },
      onPermission: (req) => bridge.onPermission(req),
      onQuestion: (req) => bridge.onQuestion(req),
      onRequestResolved: (event) => bridge.onResolved(event),
    });
    await jobUpdates.flush();
    const cancelRequested = Boolean(readJob(ctx.stateDir, jobId)?.cancelRequestedAt);
    const status = cancelRequested ? 'cancelled' : result.status;
    const completedAt = nowIso();
    await updateJob(ctx.stateDir, jobId, {
      status,
      phase: status === 'completed' ? 'done' : status,
      completedAt,
      pendingRequest: null,
      sessionID: result.sessionID,
      childSessionIDs: result.childSessionIDs,
      errorCode: status === 'completed' ? null : cancelRequested ? 'cancelled' : result.errorCode ?? null,
      errorClass: status === 'completed' ? null : result.errorClass ?? null,
      errorType: status === 'completed' ? null : cancelRequested ? 'Cancelled' : result.errorType ?? null,
      errorMessage: status === 'completed' ? null : cancelRequested ? 'Cancelled by user.' : result.errorMessage ?? null,
      attempts: [...(stored.attempts ?? []), { model: stored.model, sessionID: result.sessionID, status, errorClass: result.errorClass ?? null, startedAt, endedAt: completedAt }],
      result: {
        finalText: result.finalText,
        structured: result.structured,
        touchedFiles: result.touchedFiles,
        toolsRan: result.toolsRan,
        childSessionIDs: result.childSessionIDs,
        usage: result.usage,
        error: result.error ?? null,
      },
    });
    const statusLabel = { completed: 'concluído', failed: 'falhou', cancelled: 'cancelado', waiting_permission: 'aguardando permissão' }[status] ?? status;
    log(`Turno ${statusLabel}${result.errorType ? ` (${result.errorType})` : ''}.`);
    if (result.finalText) {
      const text = result.finalText.length > FINAL_LOG_LIMIT
        ? `${result.finalText.slice(0, FINAL_LOG_LIMIT)}\n[saída final truncada no log; consulte /opc:result ${jobId}]`
        : result.finalText;
      log(`Final output\n${text}`);
    }
  } catch (err) {
    exitCode = 7;
    let failure = err;
    try {
      await jobUpdates.flush();
    } catch (writeErr) {
      failure = new OpcError('STATE_WRITE_FAILED', `falha ao salvar o estado da tarefa: ${redact(writeErr).message}`);
    }
    const message = redact(failure instanceof Error ? failure.message : String(failure));
    log(`Falha no worker: ${message}`);
    await updateJob(ctx.stateDir, jobId, (job) => ({
      status: job.cancelRequestedAt ? 'cancelled' : 'failed',
      phase: job.cancelRequestedAt ? 'cancelled' : 'failed',
      completedAt: nowIso(),
      pendingRequest: null,
      errorCode: failure instanceof OpcError && failure.code === 'STATE_WRITE_FAILED' ? 'STATE_WRITE_FAILED' : workerErrorCode(failure),
      errorClass: 'fatal',
      errorType: failure instanceof OpcError ? failure.code : failure?.name ?? 'Error',
      errorMessage: message,
    }));
  } finally {
    bridge?.dispose();
    hub?.stop();
    releaseSession?.();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    // a lingering keep-alive socket must not keep a detached worker alive
    setTimeout(() => process.exit(exitCode), 2000).unref();
  }
  return exitCode;
}
