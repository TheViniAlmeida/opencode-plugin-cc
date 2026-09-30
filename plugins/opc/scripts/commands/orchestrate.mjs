// `opc orchestrate`: a group job with one coordinator worker.
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, OpcError, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, profileRules } from '../lib/context.mjs';
import { resolveCandidates, runWithFallback, attemptRequest, describeStop, backoffFromEnv } from '../lib/routing.mjs';
import { runTurn, newMessageId } from '../lib/runner.mjs';
import { updateJob, spawnWorker, waitForJob, appendJobLog, assertNotInsideServer, withServerLock, createGroup, addGroupMember, listGroupMembers, recordAttempt, readJob, refreshGroup } from '../lib/jobs.mjs';
import { ACTIVE_JOB_STATUSES } from '../lib/state.mjs';
import { sessionTitle, summarize } from '../lib/prompts.mjs';
import { runOrchestration, resolveSubtaskCandidates, MIN_SUBTASKS, MAX_SUBTASKS_CAP } from '../lib/orchestrator.mjs';
import { renderOrchestration, renderPermissionRequest } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';
import { maskDeep, redactText, safeOutputText } from '../lib/redact.mjs';

const FLAG_SPEC = { flags: { 'raw-args-stdin': { type: 'boolean' }, planner: { type: 'string' }, model: { type: 'string', alias: 'm' }, max: { type: 'number' }, synthesizer: { type: 'string' }, write: { type: 'boolean', default: false }, background: { type: 'boolean', default: false }, timeout: { type: 'number' }, 'wait-timeout': { type: 'number' }, json: { type: 'boolean' } }, allowPositionals: true };
const USAGE_LINE = 'uso: opc orchestrate <tarefa> [--planner modelo] [--max N] [--synthesizer claude|<modelo>] [--write] [--background]';
const DEFAULT_TURN_TIMEOUT_SEC = 1800;
function usage(message) { return new OpcError('USAGE', `${message}\n${USAGE_LINE}`, { exitCode: ExitCode.USAGE }); }

export function normalizeRequest(config, flags, positionals) {
  const task = positionals.join(' ').trim();
  if (!task) throw usage('tarefa ausente');
  const fromFlag = flags.max !== undefined;
  const maxSubtasks = fromFlag ? flags.max : config.orchestrate?.maxSubtasks ?? 5;
  if (!Number.isInteger(maxSubtasks) || maxSubtasks < MIN_SUBTASKS || maxSubtasks > MAX_SUBTASKS_CAP) throw usage(`${fromFlag ? '--max' : 'orchestrate.maxSubtasks'} deve ser um inteiro entre ${MIN_SUBTASKS} e ${MAX_SUBTASKS_CAP}`);
  if (flags.planner && flags.model && flags.planner !== flags.model) throw usage('--planner e --model divergem; use apenas --planner');
  const synthRaw = flags.synthesizer ?? config.orchestrate?.synthesizer ?? 'claude';
  if (typeof synthRaw !== 'string' || synthRaw.trim() === '') throw usage('--synthesizer deve ser "claude" ou um modelo');
  for (const name of ['timeout', 'wait-timeout']) if (flags[name] !== undefined && !(Number.isFinite(flags[name]) && flags[name] > 0)) throw usage(`--${name} deve ser um número positivo de segundos`);
  const synthesizer = synthRaw === 'claude' ? 'claude' : 'model';
  return { task, maxSubtasks, write: flags.write === true, background: flags.background === true, json: flags.json === true, planner: flags.planner ?? flags.model ?? null, synthesizer, synthesizerModel: synthesizer === 'model' ? synthRaw : null, timeoutSec: flags.timeout ?? DEFAULT_TURN_TIMEOUT_SEC, waitTimeoutSec: flags['wait-timeout'] ?? null };
}

function resolveRoute(ctx, discovery, kind, model) { return resolveCandidates({ kind, flags: model ? { model } : {}, config: ctx.config, catalog: discovery.catalog, opencodeConfig: discovery.opencodeConfig }); }
export async function createOrchestrationGroup(ctx, request, plannerRoute, synthRoute) {
  const input = { type: 'orchestrate', task: request.task, write: request.write, maxSubtasks: request.maxSubtasks, synthesizer: request.synthesizer, timeoutSec: request.timeoutSec, plannerRoute, synthRoute };
  const { group } = await withServerLock(ctx, () => createGroup(ctx.stateDir, {
    kind: 'orch', title: sessionTitle('orchestrate', summarize(request.task)), summary: summarize(request.task, 200),
    workspaceRoot: ctx.workspaceRoot, claudeSessionId: ctx.claudeSessionId ?? null, status: 'queued', phase: 'queued',
    permissionProfile: request.write ? 'write' : 'read-only', request: input,
  }, [], { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:orch' });
  return group;
}
function present(ctx, job, asJson) {
  if (job.status === 'waiting_permission') { if (asJson) ctx.json(maskDeep({ jobId: job.id, status: job.status, pendingRequest: job.pendingRequest ?? null })); else ctx.out(renderPermissionRequest(job)); return ExitCode.WAITING; }
  const pkg = job.result ?? null;
  if (asJson) ctx.json(maskDeep({ jobId: job.id, status: job.status, errorCode: job.errorCode ?? null, orchestration: pkg }));
  else ctx.out(job.rendered ?? renderOrchestration(pkg, { jobId: job.id }));
  return exitCodeForJob(job);
}

export async function run(ctx, argv) {
  const raw = await readRawArgs(argv, FLAG_SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, FLAG_SPEC);
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'informe a tarefa por --raw-args-stdin ou como argumentos, não pelos dois');
  const request = normalizeRequest(ctx.config ?? {}, flags, raw.text != null ? [raw.text] : positionals);
  assertNotInsideServer(ctx.env);
  const conn = await openApi(ctx);
  const discovery = await loadDiscovery(conn.api);
  const plannerRoute = resolveRoute(ctx, discovery, 'planner', request.planner);
  const synthRoute = request.synthesizer === 'model' ? resolveRoute(ctx, discovery, 'synthesizer', request.synthesizerModel) : null;
  for (const warning of [...plannerRoute.warnings, ...(synthRoute?.warnings ?? [])]) ctx.err(`[opc] aviso: ${warning}\n`);
  const job = await createOrchestrationGroup(ctx, request, plannerRoute, synthRoute);
  conn.close();
  await spawnWorker(ctx, job.id);
  if (request.background) { if (request.json) ctx.json({ jobId: job.id, status: 'queued', background: true }); else ctx.out(`Orquestração iniciada em background: ${job.id}\nAcompanhe com /opc:status ${job.id} --wait e veja o resultado com /opc:result ${job.id}\n`); return ExitCode.OK; }
  const final = await waitForJob(ctx, job.id, { waitTimeoutMs: request.waitTimeoutSec ? request.waitTimeoutSec * 1000 : undefined, onLog: (line) => ctx.err(`${line}\n`) });
  return present(ctx, final, request.json);
}

export function coordinatorDeps({ ctx, job, request, conn, discovery, agentsIndex, signal,
  createBridge = createRequestBridge, fallbackRunner = runWithFallback, turnRunner = runTurn, attemptRecorder = recordAttempt }) {
  const config = ctx.config ?? {}; const now = () => new Date().toISOString(); const log = (line) => appendJobLog(ctx.stateDir, job.id, `[opc] ${redactText(line)}`);
  const groupUpdates = createSerialUpdater(ctx.stateDir, job.id); const memberUpdates = new Map();
  let groupChain = Promise.resolve();
  const refresh = () => {
    groupChain = groupChain.then(() => refreshGroup(ctx.stateDir, job.id)).catch((err) => appendJobLog(ctx.stateDir, job.id, `[opc] falha ao atualizar grupo: ${safeOutputText(err?.message ?? err)}`));
    return groupChain;
  };
  const updaterFor = (id) => { if (!memberUpdates.has(id)) memberUpdates.set(id, createSerialUpdater(ctx.stateDir, id)); return memberUpdates.get(id); };
  const syncGroupPending = () => groupUpdates.update((group) => {
    if (!ACTIVE_JOB_STATUSES.includes(group.status)) return {};
    const own = (group.pendingRequest ?? []).filter((r) => !r.memberId);
    const fromMembers = listGroupMembers(ctx.stateDir, job.id).flatMap((m) => (m.pendingRequest ?? []).map((r) => ({ ...r, memberId: m.id })));
    const pending = [...own, ...fromMembers];
    if (pending.length) return { status: 'waiting_permission', phase: 'waiting_permission', pendingRequest: pending };
    return group.status === 'waiting_permission' ? { status: 'running', phase: 'running', pendingRequest: null } : { pendingRequest: null };
  }).then(() => refresh());
  const members = {
    async start(role, fields) { const m = await addGroupMember(ctx.stateDir, job.id, { kind: 'orch', role, title: fields.title, summary: fields.title, workspaceRoot: ctx.workspaceRoot, claudeSessionId: job.claudeSessionId ?? null, status: 'running', startedAt: now(), pid: null, model: fields.model ?? null, request: { type: 'orchestrate-member', subtaskId: fields.subtaskId ?? null } }); return m.id; },
    async update(id, patch) { await updaterFor(id).update(patch); },
    async finish(id, patch) { await updaterFor(id).update({ ...patch, pendingRequest: null, completedAt: now() }); memberUpdates.delete(id); await syncGroupPending(); },
  };
  const timeoutMs = (config.policy?.permissionTimeoutSec ?? 600) * 1000; const fallbackCfg = config.routing?.fallback ?? {}; const backoffMs = backoffFromEnv(ctx.env);
  const isCancelled = (memberId) => Boolean(readJob(ctx.stateDir, job.id)?.cancelRequestedAt || (memberId && readJob(ctx.stateDir, memberId)?.cancelRequestedAt));
  const bridgeUpdate = (memberId) => memberId ? async (patch) => { const v = await updaterFor(memberId).update(patch); await syncGroupPending(); return v; } : (patch) => groupUpdates.update(patch);
  const runTurnForSpec = async (spec) => {
    const label = spec.subtaskId ? `subtask ${spec.subtaskId}` : spec.role; const turnSignal = spec.signal ?? signal; const rules = profileRules(ctx, spec.profile);
    const bridge = createBridge({ update: bridgeUpdate(spec.memberId), jobId: spec.memberId ?? job.id, stateDir: ctx.stateDir, api: conn.api, profileKind: spec.profile, policy: config.policy ?? {}, timeoutMs, log: (line) => log(`${label}: ${line}`) });
    const base = { newSession: { title: spec.title, permission: rules }, childPermission: spec.profile === 'read-only' ? null : rules, parts: [{ type: 'text', text: spec.prompt }], agent: spec.agent ?? null, format: spec.format ?? null, timeoutMs: (request.timeoutSec ?? DEFAULT_TURN_TIMEOUT_SEC) * 1000, fallbackCfg };
    try {
      const outcome = await fallbackRunner({ candidates: spec.candidates, fallbackEligible: spec.fallbackEligible, fallbackCfg, write: spec.write, backoffMs, contextLimitOf: (c) => typeof c.contextLimit === 'number' ? c.contextLimit : discovery.catalog?.byFull?.get?.(c.full)?.limit?.context ?? null, signal: turnSignal, isCancelled: () => isCancelled(spec.memberId),
        runAttempt: (candidate) => turnRunner({ api: conn.api, hub: conn.hub, request: attemptRequest(base, candidate, { messageId: newMessageId }), onProgress: (event) => { if (event?.phase) log(`${label}: ${event.phase}`); }, onPermission: (req) => bridge.onPermission(req), onQuestion: (req) => bridge.onQuestion(req), onRequestResolved: (event) => bridge.onResolved(event), signal: turnSignal }),
        onAttemptStart: async (candidate) => {
          log(`${label}: tentativa em ${candidate.full}`);
          if (spec.memberId) try { await members.update(spec.memberId, { model: candidate.full, attemptInFlight: true }); }
          catch (err) { log(`${label}: falha ao registrar início da tentativa: ${safeOutputText(err?.message ?? err)}`); }
        },
        onAttemptEnd: async (record) => {
          if (!spec.memberId) return;
          try { await attemptRecorder(ctx.stateDir, spec.memberId, record); }
          catch (err) {
            log(`${label}: falha ao registrar tentativa: ${safeOutputText(err?.message ?? err)}`);
            try { await members.update(spec.memberId, { attemptInFlight: false }); }
            catch (clearErr) {
              log(`${label}: falha ao limpar attemptInFlight: ${safeOutputText(clearErr?.message ?? clearErr)}`);
              throw clearErr;
            }
          }
          if (record.sessionID) try { await members.update(spec.memberId, { sessionID: record.sessionID }); }
          catch (err) { log(`${label}: falha ao registrar sessão da tentativa: ${safeOutputText(err?.message ?? err)}`); }
        },
        onBackoff: async (delay, next) => log(`${label}: nova tentativa em ${next.full} após ${Math.round(delay / 1000)}s`),
      });
      return { ...outcome.result, status: outcome.stopReason === 'cancelled' ? 'cancelled' : outcome.result.status, model: outcome.attempts.at(-1)?.model ?? null, attempts: outcome.attempts, ...(describeStop(outcome) ?? {}) };
    } finally { bridge.dispose(); }
  };
  return { agentsIndex, signal, log, members, resolvePlanner: () => request.plannerRoute, resolveSynthesizer: () => request.synthRoute, resolveSubtask: (s) => resolveSubtaskCandidates(s, { config, catalog: discovery.catalog }) ?? resolveCandidates({ kind: s.kind, flags: {}, config, catalog: discovery.catalog, opencodeConfig: discovery.opencodeConfig }), runTurn: runTurnForSpec, refresh, flush: async () => { await groupUpdates.flush(); await groupChain; } };
}

export async function runWorker(ctx, job, request, { openApiImpl = openApi, discoveryLoader = loadDiscovery, orchestrationRunner = runOrchestration } = {}) {
  const controller = new AbortController(); const onSigterm = () => controller.abort(); process.once('SIGTERM', onSigterm);
  await updateJob(ctx.stateDir, job.id, { status: 'running', phase: 'decomposing', startedAt: new Date().toISOString() });
  let conn; let deps;
  try {
    conn = await openApiImpl(ctx, { withHub: true, respawn: false }); const discovery = await discoveryLoader(conn.api); const agentsIndex = new Map((discovery.agents ?? []).map((a) => [a.name, a]));
    deps = coordinatorDeps({ ctx, job, request, conn, discovery, agentsIndex, signal: controller.signal });
    const pkg = await orchestrationRunner({ ctx, task: request.task, flags: { write: request.write, maxSubtasks: request.maxSubtasks, synthesizer: request.synthesizer }, deps }); await deps.flush();
    const final = await refreshGroup(ctx.stateDir, job.id, { final: true, decorate: (computedGroup) => ({
      ...(['completed', 'failed', 'cancelled'].includes(computedGroup.status) && computedGroup.status !== 'cancelled'
        ? { status: computedGroup.status === 'failed' || pkg.status === 'failed' ? 'failed' : pkg.status === 'cancelled' ? 'cancelled' : computedGroup.status }
        : {}),
      result: pkg, rendered: renderOrchestration(pkg, { jobId: job.id }), errorCode: pkg.errorCode, errorMessage: pkg.errorMessage, pendingRequest: null,
    }) });
    return exitCodeForJob(final);
  } catch (err) {
    await deps?.flush().catch(() => {}); const final = await refreshGroup(ctx.stateDir, job.id, { final: true, decorate: (computedGroup) => ({ status: computedGroup.status === 'cancelled' ? 'cancelled' : 'failed', errorCode: err?.code ?? 'coordinator_error', errorMessage: redactText(err?.message ?? String(err)), pendingRequest: null }) });
    appendJobLog(ctx.stateDir, job.id, `[opc] falha do coordenador: ${redactText(err?.message ?? err)}`); return exitCodeForJob(final);
  } finally { conn?.close(); process.off('SIGTERM', onSigterm); }
}
