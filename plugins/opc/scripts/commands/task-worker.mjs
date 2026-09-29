// Internal subcommand: runs one job's turn in a detached process (spec §9.1). Users never call it.
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, NotFoundError, OpcError, UsageError } from '../lib/opc-error.mjs';
import { ensureServer } from '../lib/server.mjs';
import { createClient } from '../lib/http.mjs';
import { createApi } from '../lib/api.mjs';
import { EventHub } from '../lib/sse.mjs';
import { requiresUser } from '../lib/policy.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { redact, redactText, redactTurnOutput } from '../lib/redact.mjs';
import { acquireSessionLock, appendJobLog, clearJobRequests, consumeJobInput, readJob, runJobTurn, serverContext, updateJob } from '../lib/jobs.mjs';

// F3: group and command workers live in their own command modules.
// Later phases extend this single dispatch table.
export const WORKER_DELEGATES = Object.freeze({ sub: './subagent.mjs', cmd: './command.mjs' });

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

export function createRequestBridge({ update, jobId, stateDir, api, profileKind, policy = {}, timeoutMs = 600000, log = () => {} }) {
  if (!jobId) throw new TypeError('createRequestBridge requires jobId');
  if (!stateDir) throw new TypeError('createRequestBridge requires stateDir');
  if (typeof update !== 'function') throw new TypeError('createRequestBridge requires update');
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
  const removePending = (id) => clearJobRequests(stateDir, jobId, [id]);
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

export function workerFailureState(job, failure) {
  return {
    patch: {
      status: 'failed',
      phase: 'failed',
      completedAt: nowIso(),
      pendingRequest: null,
      errorCode: failure instanceof OpcError && failure.code === 'STATE_WRITE_FAILED' ? 'STATE_WRITE_FAILED' : workerErrorCode(failure),
      errorClass: 'fatal',
      errorType: failure instanceof OpcError ? failure.code : failure?.name ?? 'Error',
      errorMessage: redact(failure instanceof Error ? failure.message : String(failure)),
    },
    cancellationLog: job.cancelRequestedAt ? 'Cancelamento solicitado antes da falha ao salvar o estado.' : null,
  };
}

export function stateWriteFailure(err) {
  return new OpcError('STATE_WRITE_FAILED', `falha ao salvar o estado da tarefa: ${redact(err).message}`);
}

export async function delegateWorker(ctx, stored, { consumeInput = consumeJobInput, loadDelegate = (path) => import(path) } = {}) {
  const delegate = WORKER_DELEGATES[stored.kind];
  if (!delegate) throw new TypeError(`no worker delegate for ${stored.kind}`);
  let request;
  try {
    request = consumeInput(ctx.stateDir, stored.id);
  } catch (err) {
    const errorMessage = redactText(err instanceof Error ? err.message : String(err));
    const failedAt = nowIso();
    appendJobLog(ctx.stateDir, stored.id, `Falha ao consumir a entrada privada: ${errorMessage}`);
    for (const id of stored.memberIds ?? []) {
      const member = readJob(ctx.stateDir, id);
      if (member && ['queued', 'running', 'waiting_permission'].includes(member.status)) {
        await updateJob(ctx.stateDir, id, { status: 'failed', phase: 'failed', completedAt: failedAt, errorCode: err.code ?? 'JOB_INPUT_INVALID', errorClass: 'fatal', errorType: err.code ?? err.name ?? 'Error', errorMessage });
      }
    }
    const latest = readJob(ctx.stateDir, stored.id);
    if (latest && ['queued', 'running', 'waiting_permission'].includes(latest.status)) {
      await updateJob(ctx.stateDir, stored.id, { status: 'failed', phase: 'failed', completedAt: failedAt, errorCode: err.code ?? 'JOB_INPUT_INVALID', errorClass: 'fatal', errorType: err.code ?? err.name ?? 'Error', errorMessage });
    }
    return 7;
  }
  const mod = await loadDelegate(delegate);
  return mod.runWorker(ctx, stored, request);
}

export async function run(ctx, argv, {
  ensureServer: ensure = ensureServer, createApi: makeApi = createApi,
  createHub = (client) => new EventHub({ client }),
  scheduleExit = (code) => setTimeout(() => process.exit(code), 2000).unref(),
} = {}) {
  const { flags } = parseArgs(argv, { flags: { 'job-id': { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' } } });
  const jobId = flags['job-id'];
  if (!jobId) throw new UsageError('USAGE', 'task-worker exige --job-id');
  const stored = readJob(ctx.stateDir, jobId);
  if (!stored) throw new NotFoundError('NOT_FOUND', `a tarefa ${jobId} não existe`);
  if (stored.groupId) {
    throw new UsageError('GROUP_MEMBER_WORKER', `o job ${stored.id} é membro do grupo ${stored.groupId} e roda dentro do coordenador`);
  }
  const delegate = WORKER_DELEGATES[stored.kind];
  if (delegate) {
    const code = await delegateWorker(ctx, stored);
    setTimeout(() => process.exit(code), 2000).unref();
    return code;
  }
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
    const request = consumeJobInput(ctx.stateDir, jobId);
    if (readJob(ctx.stateDir, jobId)?.cancelRequestedAt) controller.abort();
    if (request.sessionID) {
      releaseSession = acquireSessionLock(ctx.stateDir, request.sessionID);
      if (!releaseSession) throw new OpcError('SESSION_BUSY', `a sessão ${request.sessionID} está bloqueada por outra tarefa`, { exitCode: 2 });
    }
    const sctx = serverContext(ctx);
    const server = await ensure(sctx);
    const client = createClient({
      baseUrl: server.url,
      password: server.password,
      directory: ctx.workspaceRoot,
      requestTimeoutMs: (ctx.config?.server?.requestTimeoutSec ?? 30) * 1000,
    });
    const api = makeApi(client);
    hub = createHub(client);
    await hub.start();
    bridge = createRequestBridge({
      update: (patch) => jobUpdates.update(patch),
      jobId,
      stateDir: ctx.stateDir,
      api,
      profileKind: request.profileKind,
      policy: ctx.config?.policy ?? {},
      timeoutMs: request.permissionTimeoutMs ?? 600000,
      log,
    });
    let lastPhase = null;
    let lastProgressLine = null;
    const childIDs = new Set(stored.childSessionIDs ?? []);
    const assistantIDs = new Set(stored.assistantMessageIDs ?? []);
    const onProgress = (event) => {
      if (event.message && event.message !== lastProgressLine) {
        lastProgressLine = event.message;
        log(event.message);
      }
      const patch = {};
      if (event.assistantMessageID) {
        assistantIDs.add(event.assistantMessageID);
        patch.assistantMessageIDs = [...assistantIDs];
      }
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
    };
    const { result: rawResult, attempts, stop } = await runJobTurn({
      stateDir: ctx.stateDir, job: { ...stored, request }, config: ctx.config, env: ctx.env, baseTurnRequest: request,
      runTurnOptions: { api, hub, signal: controller.signal, onProgress, onPermission: (req) => bridge.onPermission(req),
        onQuestion: (req) => bridge.onQuestion(req), onRequestResolved: (event) => bridge.onResolved(event) },
    });
    const result = redactTurnOutput(rawResult) ?? {
      status: 'cancelled', childSessionIDs: stored.childSessionIDs ?? [], assistantMessageIDs: [...assistantIDs],
      finalText: null, structured: null, touchedFiles: [], toolsRan: false, toolNames: [], usage: null,
    };
    await jobUpdates.flush();
    const cancelRequested = Boolean(readJob(ctx.stateDir, jobId)?.cancelRequestedAt);
    const status = cancelRequested ? 'cancelled' : result.status;
    const completedAt = nowIso();
    await updateJob(ctx.stateDir, jobId, {
      status,
      phase: status === 'completed' ? 'done' : status,
      completedAt,
      pendingRequest: null,
      childSessionIDs: result.childSessionIDs,
      assistantMessageIDs: result.assistantMessageIDs ?? [...assistantIDs],
      errorCode: status === 'completed' ? null : cancelRequested ? 'cancelled' : result.errorCode ?? null,
      errorClass: status === 'completed' ? null : result.errorClass ?? null,
      errorType: status === 'completed' ? null : cancelRequested ? 'Cancelled' : result.errorType ?? null,
      errorMessage: status === 'completed' ? null : cancelRequested ? 'Cancelado pelo usuário.' : result.errorMessage ?? null,
      result: {
        finalText: result.finalText,
        structured: result.structured,
        structuredSource: result.structuredSource ?? null,
        touchedFiles: result.touchedFiles,
        toolsRan: result.toolsRan,
        toolNames: result.toolNames,
        childSessionIDs: result.childSessionIDs,
        usage: result.usage,
        error: result.error ?? null,
        ...(result.abortConfirmed !== undefined ? { abortConfirmed: result.abortConfirmed, sessionAborts: result.sessionAborts } : {}),
      },
      model: attempts.at(-1)?.model ?? stored.model,
      sessionID: attempts.at(-1)?.sessionID ?? result.sessionID,
      ...(stop ? { errorCode: stop.errorCode, errorMessage: stop.errorMessage } : {}),
    });
    if (cancelRequested && status === 'cancelled' && attempts.length === 0) exitCode = 130;
    const statusLabel = { completed: 'concluído', failed: 'falhou', cancelled: 'cancelado', waiting_permission: 'aguardando permissão' }[status] ?? status;
    log(`Turno ${statusLabel}${result.errorType ? ` (${result.errorType})` : ''}.`);
    if (result.finalText) {
      const text = result.finalText.length > FINAL_LOG_LIMIT
        ? `${result.finalText.slice(0, FINAL_LOG_LIMIT)}\n[saída final truncada no log; consulte /opc:result ${jobId}]`
        : result.finalText;
      log(`Saída final\n${text}`);
    }
  } catch (err) {
    exitCode = 7;
    let failure = err;
    try {
      await jobUpdates.flush();
    } catch (writeErr) {
      failure = stateWriteFailure(writeErr);
    }
    const { patch, cancellationLog } = workerFailureState(readJob(ctx.stateDir, jobId), failure);
    if (cancellationLog) log(cancellationLog);
    log(`Falha no worker: ${patch.errorMessage}`);
    await updateJob(ctx.stateDir, jobId, patch);
  } finally {
    bridge?.dispose();
    hub?.stop();
    releaseSession?.();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    // a lingering keep-alive socket must not keep a detached worker alive
    scheduleExit(exitCode);
  }
  return exitCode;
}
