// `opc conclave`: parallel consultation through one coordinator worker.
import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, OpcError, toExitCode } from '../lib/opc-error.mjs';
import { openApi, profileRules } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { runTurn, newMessageId } from '../lib/runner.mjs';
import { createGroup, updateJob, readJob, spawnWorker, waitForJob, assertNotInsideServer, withServerLock, refreshGroup, appendJobLog, ACTIVE_STATUSES, listGroupMembers, recordAttempt } from '../lib/jobs.mjs';
import { resolveReviewTarget, collectReviewContext } from '../lib/git.mjs';
import { composeMembers, validateConclaveOptions, runConclave, buildKnownNames, loadConclaveAssets } from '../lib/conclave.mjs';
import { renderConclave } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';
import { redactOutput, redactText, safeOutputText } from '../lib/redact.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const SPEC = { flags: { models: { type: 'list' }, pool: { type: 'string' }, mode: { type: 'string', default: 'opinion' }, rounds: { type: 'number' }, judge: { type: 'string' }, quorum: { type: 'number' }, 'allow-judge-member': { type: 'boolean', default: false }, background: { type: 'boolean', default: false }, 'wait-timeout': { type: 'number' }, base: { type: 'string' }, scope: { type: 'string' }, json: { type: 'boolean', default: false }, 'raw-args-stdin': { type: 'boolean' } }, allowPositionals: true };
const usage = (code, message) => new OpcError(code, message, { exitCode: ExitCode.USAGE });

export async function run(ctx, argv) {
  const raw = await readRawArgs(argv, SPEC.flags, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, SPEC);
  if (raw.text != null && positionals.length) throw usage('CONFLICT', 'informe a pergunta em --raw-args-stdin ou nos argumentos, não nos dois');
  const question = (raw.text ?? positionals.join(' ')).trim();
  const mode = flags.mode;
  const models = flags.models.length ? flags.models : null;
  validateConclaveOptions({ mode, models, pool: flags.pool ?? null, quorum: flags.quorum ?? null, rounds: flags.rounds ?? null, config: ctx.config });
  if (mode !== 'review' && !question) throw usage('CONCLAVE_NO_QUESTION', 'o conclave precisa de uma pergunta: opc conclave "<pergunta>" [--models a,b | --pool nome]');
  if (mode !== 'review' && (flags.base || flags.scope)) throw usage('CONCLAVE_REVIEW_FLAGS', '--base e --scope só se aplicam a --mode review');
  const target = mode === 'review' ? resolveReviewTarget(ctx.cwd, { base: flags.base ?? null, scope: flags.scope ?? 'auto' }) : null;
  assertNotInsideServer(ctx.env);
  const conn = await openApi(ctx);
  try {
    const catalog = buildCatalog(await conn.api.providers());
    const composition = composeMembers({ models, pool: flags.pool ?? null, config: ctx.config, catalog, policy: ctx.config.policy, quorum: flags.quorum ?? null, rounds: flags.rounds ?? null, mode, judge: flags.judge ?? null, allowJudgeMember: flags['allow-judge-member'] });
    for (const warning of composition.warnings) ctx.err(`[opc] aviso: ${warning}\n`);
    const common = { summary: (question || `review ${target?.label ?? ''}`).trim().slice(0, 120), permissionProfile: 'read-only' };
    const memberFields = composition.members.map((m) => ({ ...common, kind: 'conclave-member', title: `OPC: conclave: membro ${m.label}`, role: `member:${m.label}`, model: m.full }));
    if (composition.judge.type === 'model') memberFields.push({ ...common, kind: 'conclave-judge', title: 'OPC: conclave: juiz', role: 'judge', model: composition.judge.full });
    const created = await withServerLock(ctx, async () => {
      const result = await createGroup(ctx.stateDir, {
        ...common, kind: 'conclave', title: `OPC: conclave: ${mode}`, status: 'queued', phase: 'queued', workspaceRoot: ctx.workspaceRoot,
        claudeSessionId: ctx.claudeSessionId ?? null,
        request: { type: 'conclave', question, mode, rounds: composition.rounds, quorum: composition.quorum,
          members: composition.members, judge: composition.judge, warnings: composition.warnings, target, reviewCwd: ctx.cwd },
      }, memberFields, { maxActive: ctx.config?.jobs?.maxActive ?? 8 });
      return result;
    }, { purpose: 'register-job:conclave' });
    const { group } = created;
    await spawnWorker(ctx, group.id);
    ctx.err(`[opc] conclave ${group.id}: ${composition.members.length} membros, ${composition.rounds} rodada(s), quorum ${composition.quorum}\n`);
    if (flags.background) {
      if (flags.json) ctx.json({ jobId: group.id, status: 'queued', background: true });
      else ctx.out(`Conclave ${group.id} iniciado em background.\nAcompanhe com /opc:status ${group.id} --wait e veja o resultado com /opc:result ${group.id}.\n`);
      return ExitCode.OK;
    }
    const done = await waitForJob(ctx, group.id, { waitTimeoutMs: flags['wait-timeout'] ? flags['wait-timeout'] * 1000 : undefined });
    const job = readJob(ctx.stateDir, done.id) ?? done;
    if (flags.json) ctx.json(job.result ?? { jobId: job.id, status: job.status, errorCode: job.errorCode ?? null, errorMessage: job.errorMessage ?? null });
    else ctx.out(job.rendered ?? renderConclave({ jobId: job.id, status: job.status, mode }));
    return exitCodeForJob(job);
  } finally { conn.close(); }
}

export async function runWorker(ctx, job, request, { openApiImpl = openApi, turnRunner = runTurn } = {}) {
  const now = () => new Date().toISOString();
  let conn;
  try {
    const linked = listGroupMembers(ctx.stateDir, job.id);
    const idsByRole = new Map(linked.map((m) => [m.role, m.id]));
    request = { ...request, members: request.members.map((m) => ({ ...m, jobId: idsByRole.get(`member:${m.label}`) })), judge: { ...request.judge, jobId: idsByRole.get('judge') ?? null } };
    await updateJob(ctx.stateDir, job.id, { status: 'running', phase: 'starting', startedAt: now() });
    conn = await openApiImpl(ctx, { withHub: true, respawn: false });
    const catalog = buildCatalog(await conn.api.providers());
    const knownNames = buildKnownNames(catalog, { extraModels: [...request.members, ...(request.judge.type === 'model' ? [request.judge] : [])] });
    const rules = profileRules(ctx, 'read-only');
    const ids = new Map(request.members.map((m) => [m.label, m.jobId]));
    const isCancelled = (id) => Boolean(readJob(ctx.stateDir, job.id)?.cancelRequestedAt || (id && readJob(ctx.stateDir, id)?.cancelRequestedAt));
    const turn = async (spec) => {
      const id = spec.role === 'judge' ? request.judge.jobId : ids.get(spec.label);
      await updateJob(ctx.stateDir, id, { status: 'running', phase: spec.role === 'judge' ? 'judging' : `round-${spec.round}`, attemptInFlight: true, ...(!spec.sessionID ? { startedAt: now() } : {}) });
      const result = await turnRunner({ api: conn.api, hub: conn.hub,
        request: { ...(spec.sessionID ? { sessionID: spec.sessionID } : { newSession: { title: spec.title, permission: rules } }), parts: [{ type: 'text', text: spec.prompt }], model: { providerID: spec.member.providerID, modelID: spec.member.modelID }, ...(ctx.config.conclave?.structuredOutput === 'tool' ? { format: { type: 'json_schema', schema: spec.schema } } : {}), textJson: ctx.config.conclave?.structuredOutput === 'tool' ? null : (value) => isPlainObject(value) ? null : 'resposta deve ser um objeto JSON', messageID: newMessageId(), timeoutMs: (ctx.config.conclave?.memberTimeoutSec ?? 900) * 1000, fallbackCfg: ctx.config.routing?.fallback ?? {} },
        isCancelled: () => isCancelled(id),
        onSession: ({ sessionID, childSessionIDs = [] }) => updateJob(ctx.stateDir, id, { sessionID, childSessionIDs }).then(async (updated) => { if (updated?.cancelRequestedAt || readJob(ctx.stateDir, job.id)?.cancelRequestedAt) await conn.api.abort(sessionID); }),
        onPermission: (p) => conn.api.replyPermission(p.id, { reply: 'reject', message: 'opc: sessões do conclave são somente leitura' }),
        onQuestion: (q) => conn.api.rejectQuestion(q.id),
      });
      await recordAttempt(ctx.stateDir, id, { model: spec.member.full, status: result.status, sessionID: result.sessionID ?? null, errorType: result.errorType ?? null, errorClass: result.errorClass ?? null, errorMessage: safeOutputText(result.errorMessage ?? '') || null, completedAt: now() });
      return result;
    };
    const pkg = await runConclave({ ctx: { config: ctx.config, workspaceRoot: ctx.workspaceRoot }, question: request.question,
      flags: { mode: request.mode, rounds: request.rounds, quorum: request.quorum, members: request.members, judge: request.judge, warnings: request.warnings ?? [], maxParallel: ctx.config.jobs?.maxParallel ?? 4 },
      deps: { turn, knownNames, assets: loadConclaveAssets(), collectReview: request.mode === 'review' ? () => ({ ...collectReviewContext(request.reviewCwd ?? ctx.cwd, request.target), label: request.target?.label ?? null }) : null,
        onEvent: async (event) => {
          if (event.type === 'member-failed') { const id = ids.get(event.label); if (id) await updateJob(ctx.stateDir, id, { status: 'failed', errorCode: event.errorType, errorMessage: safeOutputText(event.message), attemptInFlight: false, completedAt: now() }); }
          if (event.type === 'member-done') { const id = ids.get(event.label); if (id) await updateJob(ctx.stateDir, id, { attemptInFlight: false }); }
          if (event.type === 'judge-failed' || event.type === 'judge-done') { const id = request.judge.jobId; if (id) await updateJob(ctx.stateDir, id, { attemptInFlight: false }); }
        } } });
    const result = redactOutput({ jobId: job.id, ...pkg });
    const rendered = redactOutput(renderConclave(result));
    for (const m of request.members) { const current = readJob(ctx.stateDir, m.jobId); if (current && ACTIVE_STATUSES.includes(current.status)) await updateJob(ctx.stateDir, m.jobId, { status: 'completed', phase: 'done', attemptInFlight: false, completedAt: now() }); }
    if (request.judge.jobId) { const current = readJob(ctx.stateDir, request.judge.jobId); if (current && ACTIVE_STATUSES.includes(current.status)) await updateJob(ctx.stateDir, request.judge.jobId, { status: pkg.judge.status === 'completed' ? 'completed' : 'failed', phase: 'done', attemptInFlight: false, completedAt: now() }); }
    const final = await refreshGroup(ctx.stateDir, job.id, { final: true, decorate: (g) => ({ ...(g.status === 'cancelled' ? {} : { status: pkg.status }), result, rendered, pendingRequest: null }) });
    return exitCodeForJob(final);
  } catch (err) {
    const message = safeOutputText(err?.message ?? String(err));
    appendJobLog(ctx.stateDir, job.id, `[opc] falha do conclave: ${message}`);
    const final = await refreshGroup(ctx.stateDir, job.id, { final: true, decorate: (g) => ({ status: g.status === 'cancelled' ? 'cancelled' : 'failed', errorCode: err?.code ?? 'coordinator_error', errorMessage: message, pendingRequest: null }) });
    return exitCodeForJob(final) ?? toExitCode(err);
  } finally { conn?.close(); }
}
