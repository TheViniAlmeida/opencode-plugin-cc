// Adapted from openai/codex-plugin-cc (Apache-2.0); modified: runs as an opc read-only job, reads the
// transcript when last_assistant_message is missing, and allows the stop on any infrastructure failure.
import fs from 'node:fs';

import { parseHookInput, readStdin } from '../lib/args.mjs';
import { connectApi, contextForCwd } from '../lib/context.mjs';
import { OpcError } from '../lib/opc-error.mjs';
import { resolveTurnModel } from '../lib/routing.mjs';
import { ACTIVE_STATUSES, cancelJob, liveActiveJobs, submitTurnJob, turnJobRequest, waitForJob } from '../lib/jobs.mjs';
import { fillTemplate, loadPrompt, projectContextBlock } from '../lib/prompts.mjs';
import { collectReviewContext, resolveReviewTarget } from '../lib/git.mjs';
import { maskSecretPatterns, redactText } from '../lib/redact.mjs';

export const STOP_GATE_TURN_TIMEOUT_MS = 840_000;
export const DEFAULT_STOP_GATE_WAIT_MS = 840_000;
export const STOP_HOOK_DEADLINE_MS = 900_000;
export const STOP_CANCEL_RESERVE_MS = 60_000;
const MAX_MESSAGE_CHARS = 50_000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const GATE_CONTEXT_BYTES = 200 * 1024;
const MAX_BLOCK_REASON_CHARS = 2000;

function safeText(value) {
  return redactText(maskSecretPatterns(String(value ?? '')));
}

export function parseStopGateOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'malformed', reason: 'saída vazia' };
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (first.startsWith('ALLOW:')) return { kind: 'allow', reason: first.slice('ALLOW:'.length).trim() };
  if (first.startsWith('BLOCK:')) return { kind: 'block', reason: first.slice('BLOCK:'.length).trim() || 'motivo não informado' };
  return { kind: 'malformed', reason: 'formato de resposta inválido' };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

export function lastAssistantTextFromTranscript(transcriptPath) {
  if (!transcriptPath) return '';
  let text;
  try {
    const { size } = fs.statSync(transcriptPath);
    const length = Math.min(size, MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
    text = buffer.toString('utf8');
  } catch { return ''; }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.message ?? entry;
    if ((message?.role ?? entry?.type) !== 'assistant') continue;
    const value = textOf(message?.content).trim();
    if (value) return value;
  }
  return '';
}

export function buildStopGatePrompt({ lastMessage, repositoryContext, project = null }) {
  const message = String(lastMessage ?? '').trim();
  const clipped = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}\n[truncado]` : message;
  return redactText(fillTemplate(loadPrompt('stop-review-gate'), {
    CLAUDE_RESPONSE_BLOCK: clipped ? `Resposta anterior do Claude:\n${safeText(clipped)}` : 'Resposta anterior do Claude: (indisponível)',
    REPOSITORY_CONTEXT: safeText(repositoryContext) || '(contexto do repositório indisponível)',
    PROJECT_CONTEXT: safeText(projectContextBlock(project)),
  }));
}

function repositoryContextFor(ctx) {
  try {
    const target = resolveReviewTarget(ctx.cwd, { scope: 'working-tree' });
    const context = collectReviewContext(ctx.cwd, target, { maxInlineBytes: GATE_CONTEXT_BYTES, excludeGlobs: ctx.config?.policy?.sensitivePaths ?? [] });
    if (context.files.length === 0) return 'Árvore de trabalho limpa: não há alterações não commitadas.';
    return [context.summary, context.guidance, context.content].join('\n\n');
  } catch { return '(contexto do repositório indisponível)'; }
}

function envMs(value, fallback) {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function failureCause(failure) {
  const turn = failure?.result ?? {};
  const error = turn.error ?? failure?.error;
  const code = error?.name ?? turn.errorName ?? turn.errorType ?? turn.errorCode
    ?? failure?.errorName ?? failure?.errorType ?? failure?.errorCode ?? failure?.code ?? failure?.name ?? 'Error';
  const message = error?.data?.message ?? error?.message ?? turn.errorMessage ?? failure?.errorMessage
    ?? failure?.message ?? `Tarefa encerrada como ${failure?.status ?? 'desconhecido'}.`;
  return safeText(`${code}: ${message}`).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function allowWithWarning(ctx, message) {
  ctx.out(`${JSON.stringify({ systemMessage: redactText(message) })}\n`);
  return 0;
}

function allowAfterFailure(ctx, err) {
  const diagnostic = `STOP_GATE_FAILED (${failureCause(err?.cause ?? err)})`;
  ctx.err(`[opc] ${diagnostic}\n`);
  let message = `opc stop gate não pôde ser executado e permitiu o encerramento: ${diagnostic}. Execute /opc:setup para diagnosticar.`;
  if (err?.cancelFailure) {
    const { id, code: cancelCode } = err.cancelFailure;
    const note = `A tarefa do gate ${id} não pôde ser cancelada (${cancelCode}) e ainda pode estar em execução; use /opc:cancel ${id}.`;
    message += ` ${note}`;
    ctx.err(redactText(`[opc] ${note}\n`));
  }
  return allowWithWarning(ctx, message);
}

function noteActiveJobs(ctx, sessionId) {
  for (const job of liveActiveJobs(ctx.stateDir, { claudeSessionId: sessionId })) {
    ctx.err(redactText(`[opc] a tarefa ${job.id} (${job.kind}) ainda está em execução. Consulte /opc:status ${job.id} ou cancele com /opc:cancel ${job.id}.\n`));
  }
}

async function cancelGateJob(ctx, jobId, cancelJobFn) {
  try {
    const result = await cancelJobFn(ctx, jobId);
    return result?.ok === false ? { id: jobId, code: result.code ?? 'CANCEL_FAILED' } : null;
  } catch (err) {
    return { id: jobId, code: err?.code ?? 'CANCEL_FAILED' };
  }
}

function attachCancelFailure(err, failure) {
  if (!failure) return err;
  const error = err instanceof Error ? err : new OpcError('STOP_GATE_FAILED', String(err));
  error.cancelFailure = failure;
  return error;
}

async function runStopGate(ctx, input, sessionId, dependencies = {}) {
  const cancelJobFn = dependencies.cancelJobFn ?? cancelJob;
  const waitForJobFn = dependencies.waitForJobFn ?? waitForJob;
  const connectApiFn = dependencies.connectApiFn ?? connectApi;
  const resolveTurnModelFn = dependencies.resolveTurnModelFn ?? resolveTurnModel;
  const turnJobRequestFn = dependencies.turnJobRequestFn ?? turnJobRequest;
  const submitTurnJobFn = dependencies.submitTurnJobFn ?? submitTurnJob;
  const lastMessage = input.last_assistant_message || lastAssistantTextFromTranscript(input.transcript_path);
  const { api } = await connectApiFn(ctx);
  const resolved = await resolveTurnModelFn({ api, kind: 'stop-gate', flags: {}, config: ctx.config });
  const request = turnJobRequestFn({
    kind: 'stop-gate', profile: 'read-only',
    prompt: buildStopGatePrompt({ lastMessage: redactText(lastMessage), repositoryContext: repositoryContextFor(ctx), project: ctx.config?.project ?? null }),
    model: resolved.model, modelFull: resolved.full, variant: resolved.variant,
    timeoutMs: STOP_GATE_TURN_TIMEOUT_MS, title: 'OPC: stop-gate: revisão da resposta anterior', config: ctx.config ?? {},
  });
  const job = await submitTurnJobFn(ctx, { kind: 'stop-gate', title: request.title, summary: 'Revisão de bloqueio da resposta anterior do Claude', request, claudeSessionId: sessionId });
  let done;
  try {
    const remaining = dependencies.deadline - dependencies.now() - STOP_CANCEL_RESERVE_MS;
    if (remaining <= 0) throw new OpcError('STOP_GATE_TIMEOUT', 'O orçamento total do hook foi esgotado.');
    done = await waitForJobFn(ctx, job.id, { waitTimeoutMs: Math.min(remaining, envMs(ctx.env.OPC_STOP_GATE_WAIT_MS, DEFAULT_STOP_GATE_WAIT_MS)) });
  }
  catch (err) {
    const failure = await cancelGateJob(ctx, job.id, cancelJobFn);
    throw attachCancelFailure(err, failure);
  }
  if (done.status !== 'completed') {
    const failure = ACTIVE_STATUSES.includes(done.status) ? await cancelGateJob(ctx, done.id, cancelJobFn) : null;
    const error = new OpcError('STOP_GATE_FAILED', 'A tarefa stop-gate falhou.');
    error.cause = done;
    throw attachCancelFailure(error, failure);
  }
  return parseStopGateOutput(done.result?.finalText);
}

export async function run(ctx, dependencies = {}) {
  const now = dependencies.now ?? (() => performance.now());
  const enteredAt = ctx.hookEnteredAt ?? now();
  dependencies = { ...dependencies, now, deadline: enteredAt + STOP_HOOK_DEADLINE_MS };
  const input = parseHookInput(await readStdin(ctx.stdin));
  let hctx;
  try { hctx = contextForCwd(ctx, input.cwd || ctx.env.CLAUDE_PROJECT_DIR || ctx.cwd); }
  catch (err) { return allowAfterFailure(ctx, err); }
  const sessionId = input.session_id || ctx.claudeSessionId || null;
  try { noteActiveJobs(hctx, sessionId); } catch { /* best effort */ }
  if (hctx.config?.stopGate?.enabled !== true || input.stop_hook_active === true) return 0;
  let verdict;
  try { verdict = await (dependencies.runStopGateFn ?? runStopGate)(hctx, input, sessionId, dependencies); }
  catch (err) {
    return allowAfterFailure(ctx, err);
  }
  if (verdict.kind === 'block') {
    const reason = safeText(verdict.reason).slice(0, MAX_BLOCK_REASON_CHARS);
    ctx.out(`${JSON.stringify({ decision: 'block', reason: redactText(`opc stop gate: ${reason}`) })}\n`);
    return 0;
  }
  if (verdict.kind === 'malformed') return allowWithWarning(ctx, `opc stop gate retornou uma resposta inesperada (${safeText(verdict.reason)}) e permitiu o encerramento. Execute /opc:review --wait para revisar manualmente.`);
  return 0;
}
