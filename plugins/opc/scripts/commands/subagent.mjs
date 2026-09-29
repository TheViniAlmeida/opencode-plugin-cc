import { readFileSync } from 'node:fs';
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, requireAgent, resolveModel, profileRules } from '../lib/context.mjs';
import {
  createGroup, spawnWorker, waitForJob, readJob, updateJob, appendJobLog, listGroupMembers, refreshGroup,
  runWithConcurrency, assertNotInsideServer, withServerLock, ACTIVE_STATUSES,
} from '../lib/jobs.mjs';
import { dispatchSubagent, SUBAGENT_MECHANISMS } from '../lib/runner.mjs';
import { renderGroupStatus, renderGroupResult } from '../lib/render.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { exitCodeForJob } from './task.mjs';
import { createRequestBridge, createSerialUpdater } from './task-worker.mjs';
import { safeOutputText } from '../lib/redact.mjs';

export const MAX_SUBAGENTS = 8;
const DEFAULT_TURN_TIMEOUT_SEC = 1800;
const SUBAGENT_MODES = ['subagent', 'all'];
const SPEC = {
  flags: {
    agent: { type: 'list' }, model: { type: 'list', alias: 'm' }, variant: { type: 'string' }, effort: { type: 'string' },
    write: { type: 'boolean' }, background: { type: 'boolean' }, mechanism: { type: 'string', default: 'child-session' },
    'prompt-file': { type: 'string' }, timeout: { type: 'number' }, 'wait-timeout': { type: 'number' },
    json: { type: 'boolean' }, cwd: { type: 'string' }, 'raw-args-stdin': { type: 'boolean' },
  }, allowPositionals: true,
};
const splitList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
  .flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);

export function waitTimeoutMsFromFlags(flags) {
  const value = flags['wait-timeout'];
  if (value === undefined) return undefined;
  const ms = value * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError('USAGE', 'os tempos limite devem ser números positivos de segundos');
  return ms;
}

export function buildMemberFields(specs, summary, profile) {
  return specs.map((spec, i) => ({ title: spec.title, summary, agent: spec.agent, model: spec.full, variant: spec.variant ?? null,
    permissionProfile: profile, role: `member:${i + 1}`, memberIndex: i }));
}

export function pairAgentsAndModels(agents, models) {
  if (!agents.length) throw new UsageError('NO_AGENT', 'informe --agent a[,b,c] (veja /opc:agents --mode subagent)');
  let pairs;
  if (models.length <= 1) pairs = agents.map((agent) => ({ agent, model: models[0] ?? null }));
  else if (agents.length === 1) pairs = models.map((model) => ({ agent: agents[0], model }));
  else if (agents.length === models.length) pairs = agents.map((agent, i) => ({ agent, model: models[i] }));
  else throw new UsageError('AGENT_MODEL_MISMATCH', `--agent tem ${agents.length} itens e --model tem ${models.length}; use listas do mesmo tamanho, ou 1 agente, ou 1 modelo`);
  if (pairs.length > MAX_SUBAGENTS) throw new UsageError('TOO_MANY_SUBAGENTS', `no máximo ${MAX_SUBAGENTS} subagentes por grupo (pedidos: ${pairs.length})`);
  return pairs;
}

function summaryOf(prompt, max = 12) {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
const logLine = (ctx) => (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`);

export async function run(ctx, argv) {
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'use o texto do stdin (--raw-args-stdin) ou argumentos posicionais, não os dois');
  let prompt;
  if (flags['prompt-file']) {
    try { prompt = readFileSync(flags['prompt-file'], 'utf8'); }
    catch (err) {
      const pathPreview = `${String(flags['prompt-file']).slice(0, 12)}…`;
      throw new UsageError('PROMPT_FILE', `não foi possível ler --prompt-file ${pathPreview}: ${err.code ?? 'erro de leitura'}`);
    }
  } else prompt = raw.text ?? positionals.join(' ');
  if (!prompt.trim()) throw new UsageError('NO_PROMPT', 'informe o prompt dos subagentes (texto ou --prompt-file)');
  if (!SUBAGENT_MECHANISMS.includes(flags.mechanism)) throw new UsageError('INVALID_MECHANISM', `--mechanism deve ser ${SUBAGENT_MECHANISMS.join(' ou ')}`);
  const pairs = pairAgentsAndModels(splitList(flags.agent), splitList(flags.model));
  const variant = flags.variant ?? flags.effort ?? null;
  const timeoutSec = flags.timeout ?? DEFAULT_TURN_TIMEOUT_SEC;
  const waitTimeoutMs = waitTimeoutMsFromFlags(flags);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new UsageError('USAGE', 'os tempos limite devem ser números positivos de segundos');
  }
  assertNotInsideServer(ctx.env);
  const conn = await openApi(ctx);
  let discovery;
  try { discovery = await loadDiscovery(conn.api); } finally { conn.close(); }
  const policy = ctx.config.policy ?? {};
  const profile = flags.write ? 'write' : 'read-only';
  const summary = summaryOf(prompt);
  const specs = pairs.map((pair, i) => {
    const agent = requireAgent(discovery, pair.agent, policy, { modes: SUBAGENT_MODES });
    const model = resolveModel(ctx, discovery, 'task', pair.model, { variant });
    return { agent: agent.name, model: { providerID: model.providerID, modelID: model.modelID }, full: model.full,
      variant: model.variant, title: `OPC: sub: #${i + 1} ${agent.name}: ${summary}`.slice(0, 120) };
  });
  const maxParallel = flags.write ? 1 : Math.max(1, Number(ctx.config.jobs?.maxParallel ?? 4));
  const request = { prompt, mechanism: flags.mechanism, profile, rules: profileRules(ctx, profile), timeoutMs: timeoutSec * 1000,
    maxParallel, fallbackCfg: ctx.config.routing?.fallback ?? null, members: specs };
  const { group, members } = await withServerLock(ctx, () => createGroup(ctx.stateDir, {
    kind: 'sub', title: `OPC: subagents: ${summary}`, summary, workspaceRoot: ctx.workspaceRoot,
    claudeSessionId: ctx.claudeSessionId, permissionProfile: profile, request,
  }, buildMemberFields(specs, summary, profile),
  { maxActive: ctx.config?.jobs?.maxActive ?? 8 }), { purpose: 'register-job:sub' });
  await spawnWorker(ctx, group.id);
  if (flags.background) {
    const current = readJob(ctx.stateDir, group.id) ?? group;
    if (flags.json) ctx.json({ group: current, members }); else ctx.out(renderGroupStatus(current, members));
    return ExitCode.OK;
  }
  const final = await waitForJob(ctx, group.id, { waitTimeoutMs, onLog: logLine(ctx) });
  const finalMembers = listGroupMembers(ctx.stateDir, group.id);
  if (flags.json) ctx.json({ group: final, members: finalMembers });
  else if (ACTIVE_STATUSES.includes(final.status)) ctx.out(renderGroupStatus(final, finalMembers));
  else ctx.out(final.rendered ?? renderGroupResult(final, finalMembers));
  return exitCodeForJob(final);
}

function memberResult(res, spec, fallbackMechanism) {
  return { finalText: res.finalText ?? '', structured: res.structured ?? null, error: res.error ?? null,
    errorClass: res.errorClass ?? null, errorType: res.errorType ?? null, errorMessage: res.errorMessage ?? null,
    sessionID: res.sessionID ?? null, mechanism: res.mechanism ?? fallbackMechanism, fellBack: Boolean(res.fellBack),
    carrierSessionID: res.carrierSessionID ?? null, touchedFiles: res.touchedFiles ?? [], toolsRan: Boolean(res.toolsRan),
    childSessionIDs: res.childSessionIDs ?? [], usage: res.usage ?? null, model: spec.full, agent: spec.agent };
}

export async function runWorker(ctx, groupJob, request, {
  openApi: makeConnection = openApi, dispatch: dispatch = dispatchSubagent, createBridge = createRequestBridge,
} = {}) {
  const { stateDir } = ctx;
  const req = request;
  const memberIds = groupJob.memberIds ?? [];
  const now = () => new Date().toISOString();
  let chain = Promise.resolve();
  const refresh = () => {
    chain = chain.then(() => refreshGroup(stateDir, groupJob.id)).catch((err) => appendJobLog(stateDir, groupJob.id, `[opc] falha ao atualizar grupo: ${safeOutputText(err.message)}`));
    return chain;
  };
  let conn;
  try {
    conn = await makeConnection(ctx, { withHub: true, respawn: false });
    const { api, hub } = conn;
    const parent = await api.createSession({ title: groupJob.title, permission: req.rules });
    const coordinator = { pid: process.pid, pidStartTime: getProcessIdentity(process.pid)?.startTime ?? null };
    await updateJob(stateDir, groupJob.id, { status: 'running', startedAt: now(), sessionID: parent.id });
    for (const id of memberIds) await updateJob(stateDir, id, { parentSessionID: parent.id, pid: coordinator.pid, pidStartTime: coordinator.pidStartTime });
    const policy = ctx.config.policy ?? {};
    const outcomes = await runWithConcurrency(memberIds, req.maxParallel ?? 4, async (memberId, index) => {
      const spec = req.members[index];
      const tag = `[#${index + 1} ${spec.agent}]`;
      let bridge;
      let updater;
      try {
        if (readJob(stateDir, groupJob.id)?.status === 'cancelled' || readJob(stateDir, memberId)?.status !== 'queued') return;
        await updateJob(stateDir, memberId, { status: 'running', phase: 'starting', startedAt: now() });
        appendJobLog(stateDir, groupJob.id, `${tag} iniciando (${spec.full})`);
        await refresh();
        updater = createSerialUpdater(stateDir, memberId);
        bridge = createBridge({ update: async (patch) => { const job = await updater.update(patch); await refresh(); return job; },
          jobId: memberId, stateDir, api, profileKind: req.profile, policy, timeoutMs: (policy.permissionTimeoutSec ?? 600) * 1000,
          log: (line) => appendJobLog(stateDir, groupJob.id, `${tag} ${line}`) });
        let res;
        try {
          res = await dispatch({ api, hub, parentSessionID: parent.id, member: spec, prompt: req.prompt, rules: req.rules,
            mechanism: req.mechanism, timeoutMs: req.timeoutMs, fallbackCfg: req.fallbackCfg,
            onSession: async (sessionID) => { const job = await updateJob(stateDir, memberId, { sessionID }); if (job?.status === 'cancelled') await api.abort(sessionID).catch(() => {}); },
            onProgress: (p) => { const phase = typeof p === 'string' ? p : p?.phase; if (!phase) return; appendJobLog(stateDir, groupJob.id, `${tag} ${phase}`); updateJob(stateDir, memberId, { phase }).catch(() => {}); },
            onPermission: (request) => bridge.onPermission(request), onQuestion: (request) => bridge.onQuestion(request),
            onRequestResolved: (event) => bridge.onResolved(event) });
        } catch (err) {
          res = { status: 'failed', errorType: err.code ?? err.name ?? 'Error', errorMessage: safeOutputText(err.message), finalText: '', sessionID: readJob(stateDir, memberId)?.sessionID ?? null };
        }
        await updater.flush();
        const latest = readJob(stateDir, memberId);
        const status = latest?.status === 'cancelled' ? 'cancelled' : res.status;
        await updateJob(stateDir, memberId, { status, phase: status, completedAt: now(), sessionID: res.sessionID ?? latest?.sessionID ?? null,
          errorClass: res.errorClass ?? null, errorType: res.errorType ?? null, errorMessage: res.errorMessage ? safeOutputText(res.errorMessage) : null,
          childSessionIDs: res.childSessionIDs ?? [], pendingRequest: null, result: memberResult(res, spec, req.mechanism) });
        appendJobLog(stateDir, groupJob.id, `${tag} ${status}`);
      } catch (err) {
        const errorMessage = safeOutputText(err instanceof Error ? err.message : String(err));
        const latest = readJob(stateDir, memberId);
        if (latest && ['queued', 'running', 'waiting_permission'].includes(latest.status)) {
          await updateJob(stateDir, memberId, { status: 'failed', phase: 'failed', completedAt: now(), errorCode: err.code ?? 'member_setup_failed', errorClass: 'fatal', errorType: err.code ?? err.name ?? 'Error', errorMessage });
        }
        appendJobLog(stateDir, groupJob.id, `${tag} falhou: ${errorMessage}`);
      } finally { bridge?.dispose(); }
      await refresh();
    });
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'rejected') continue;
      const memberId = memberIds[index];
      const errorMessage = safeOutputText(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      const latest = readJob(stateDir, memberId);
      if (latest && ACTIVE_STATUSES.includes(latest.status)) {
        await updateJob(stateDir, memberId, { status: 'failed', phase: 'failed', completedAt: now(), errorCode: outcome.reason?.code ?? 'member_lane_failed', errorClass: 'fatal', errorType: outcome.reason?.code ?? outcome.reason?.name ?? 'Error', errorMessage });
      }
      appendJobLog(stateDir, groupJob.id, `[#${index + 1}] falha da lane: ${errorMessage}`);
      await refresh();
    }
    await chain;
    const finalGroup = await refreshGroup(stateDir, groupJob.id, { final: true });
    await updateJob(stateDir, groupJob.id, { rendered: renderGroupResult(finalGroup, listGroupMembers(stateDir, groupJob.id)) });
    return exitCodeForJob(finalGroup);
  } catch (err) {
    const errorMessage = safeOutputText(err instanceof Error ? err.message : String(err));
    appendJobLog(stateDir, groupJob.id, `[opc] falha no coordenador: ${errorMessage}`);
    for (const id of memberIds) {
      const m = readJob(stateDir, id);
      if (m && ACTIVE_STATUSES.includes(m.status)) await updateJob(stateDir, id, { status: 'failed', errorCode: 'coordinator_error', errorMessage, completedAt: now() });
    }
    const g = readJob(stateDir, groupJob.id);
    if (g && g.status !== 'cancelled') await updateJob(stateDir, groupJob.id, { status: 'failed', errorCode: 'coordinator_error', errorMessage, completedAt: now() });
    return ExitCode.JOB_FAILED;
  } finally { conn?.close(); }
}
