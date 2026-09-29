import { parseArgs, readRawArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { collectReviewContext, diffSizeEstimate, resolveReviewTarget } from '../lib/git.mjs';
import { connectApi } from '../lib/context.mjs';
import { resolveTurnModel, routingFields } from '../lib/routing.mjs';
import { assertNotInsideServer, submitTurnJob, turnJobRequest, waitForJob } from '../lib/jobs.mjs';
import { fillTemplate, loadPrompt, loadSchema, projectContextBlock, sessionTitle, summarize } from '../lib/prompts.mjs';
import { renderAttempts, renderReviewEstimate, renderReviewJob, validateReviewOutput } from '../lib/render.mjs';
import { redactText, safeOutputText } from '../lib/redact.mjs';
import { exitCodeForJob } from './task.mjs';

export const REVIEW_TURN_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_REVIEW_WAIT_TIMEOUT_SEC = 540;
export const REVIEW_FLAGS = {
  wait: { type: 'boolean' }, background: { type: 'boolean' }, estimate: { type: 'boolean' },
  base: { type: 'string' }, scope: { type: 'string', default: 'auto' },
  model: { type: 'string', alias: 'm' }, variant: { type: 'string' }, effort: { type: 'string' },
  'wait-timeout': { type: 'number' }, json: { type: 'boolean' }, cwd: { type: 'string' }, 'raw-args-stdin': { type: 'boolean' },
};
const RAW_REVIEW_FLAGS = Object.fromEntries(Object.entries(REVIEW_FLAGS).filter(([name]) => name !== 'raw-args-stdin'));
const LABELS = { review: 'Revisão', adversarial: 'Revisão Adversarial' };
const PROMPT_NAMES = { review: 'review', adversarial: 'adversarial-review' };

export function recommendReviewMode({ files, insertions, deletions }) {
  if (files === 0) return 'nothing';
  return files <= 2 && insertions + deletions <= 300 ? 'wait' : 'background';
}

export const REVIEW_PROMPT_BYTES = 400 * 1024;
export const REVIEW_FOCUS_BYTES = 16 * 1024;

function validateFocus(focus) {
  if (Buffer.byteLength(focus) > REVIEW_FOCUS_BYTES) throw new UsageError('USAGE', 'O foco da revisão deve ter no máximo 16 KB.');
}

export function buildReviewPrompt({ variant, target, context, focus = '', project = null }) {
  validateFocus(focus);
  return redactText(fillTemplate(loadPrompt(PROMPT_NAMES[variant]), {
    TARGET_LABEL: safeOutputText(target.label),
    USER_FOCUS: safeOutputText(focus) || 'Nenhum foco adicional informado.',
    REVIEW_COLLECTION_GUIDANCE: context.guidance,
    REVIEW_INPUT: safeOutputText([context.summary, context.content].join('\n\n')),
    PROJECT_CONTEXT: safeOutputText(projectContextBlock(project)),
  }));
}

// Recollect through git's graded whole-section levels until the complete prompt fits.
export function collectReviewPrompt(cwd, options, { excludeGlobs = [], collectContext = collectReviewContext } = {}) {
  validateFocus(options.focus ?? '');
  let budget = REVIEW_PROMPT_BYTES;
  while (budget > 0) {
    const context = collectContext(cwd, options.target, { excludeGlobs, maxInlineBytes: budget });
    const prompt = buildReviewPrompt({ ...options, context });
    const excess = Buffer.byteLength(prompt) - REVIEW_PROMPT_BYTES;
    if (excess <= 0) return { prompt, context: { ...context, truncated: context.truncated || budget < REVIEW_PROMPT_BYTES } };
    budget -= excess + 1024;
  }
  throw new UsageError('REVIEW_CONTEXT_LIMIT', 'O contexto fixo da revisão excede o limite de 400 KB. Reduza o contexto do projeto ou o foco.');
}

function writeLog(ctx, line) { const text = String(line); ctx.err(text.endsWith('\n') ? text : `${text}\n`); }
function renderBackgroundStart(label, job) {
  return [`# OPC ${label}`, '', `Revisão iniciada em segundo plano: ${job.id}`,
    `- Progresso: /opc:status ${job.id}`, `- Aguardar: /opc:status ${job.id} --wait`, `- Resultado: /opc:result ${job.id}`, ''].join('\n');
}
function emitReviewResult(ctx, job, { json }) {
  if (job.status === 'waiting_permission') {
    if (json) ctx.json({ job, pendingRequest: job.pendingRequest ?? null });
    else ctx.out(`# OPC Revisão\n\nJob ${job.id} aguarda resposta de permissão. Execute /opc:permissions list.\n`);
    return ExitCode.WAITING;
  }
  if (json) {
    const structured = job.result?.structured ?? null;
    ctx.json({ jobId: job.id, status: job.status, review: structured, schemaValid: structured ? validateReviewOutput(structured) === null : false, errorType: job.result?.errorType ?? job.errorType ?? null, rendered: renderReviewJob(job) });
  } else ctx.out(`${renderReviewJob(job)}${renderAttempts(job.attempts)}`);
  return exitCodeForJob(job);
}

export async function runReviewCommand(ctx, argv, { variant }) {
  const label = LABELS[variant];
  const raw = await readRawArgs(argv, RAW_REVIEW_FLAGS, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(raw.argv, { flags: REVIEW_FLAGS, allowPositionals: true });
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'informe o foco em linha de comando ou por --raw-args-stdin, não nos dois.');
  if (flags.wait && flags.background) throw new UsageError('USAGE', 'Use --wait ou --background, não os dois.');
  if (flags.variant && flags.effort && flags.variant !== flags.effort) throw new UsageError('USAGE', '--effort é um alias de --variant; informe apenas um deles.');
  const parsedFocus = raw.text ?? positionals.join(' ');
  const focus = parsedFocus.trim() ? parsedFocus : '';
  validateFocus(focus);
  if (variant === 'review' && focus) throw new UsageError('USAGE', `/opc:review não aceita texto de foco. Use /opc:adversarial-review ${focus.slice(0, 12)}${focus.length > 12 ? '…' : ''}`);

  const target = resolveReviewTarget(ctx.cwd, { base: flags.base ?? null, scope: flags.scope ?? 'auto' });
  if (flags.estimate) {
    const size = diffSizeEstimate(ctx.cwd, target);
    const estimate = { target: { mode: target.mode, label: target.label, baseRef: target.baseRef ?? null }, ...size, recommendation: recommendReviewMode(size) };
    if (flags.json) ctx.json(estimate); else ctx.out(renderReviewEstimate(estimate));
    return ExitCode.OK;
  }
  assertNotInsideServer(ctx.env);
  const { context, prompt } = collectReviewPrompt(ctx.cwd, { variant, target, focus, project: ctx.config?.project ?? null }, { excludeGlobs: ctx.config?.policy?.sensitivePaths ?? [] });
  if (context.files.length === 0) {
    if (flags.json) ctx.json({ jobId: null, status: 'nothing-to-review', target: target.label });
    else ctx.out(`# OPC ${label}\n\nNada para revisar: ${target.label} não tem alterações.\n`);
    return ExitCode.OK;
  }
  if (context.truncated) writeLog(ctx, `[opc] diff tem ${context.diffBytes} bytes; enviando estatísticas e ${context.includedFiles.length} de ${context.files.length} diffs de arquivos (menores primeiro).`);
  const { api } = await connectApi(ctx);
  const resolved = await resolveTurnModel({ api, kind: 'review', flags: { model: flags.model, variant: flags.variant ?? flags.effort }, config: ctx.config });
  for (const warning of resolved.warnings) writeLog(ctx, `[opc] ${warning}`);
  const title = sessionTitle(variant === 'review' ? 'review' : 'adversarial-review', summarize(focus ? `${target.label} — ${focus}` : target.label));
  const request = turnJobRequest({
    kind: 'review', profile: 'read-only', prompt,
    model: resolved.model, modelFull: resolved.full, variant: resolved.variant,
    format: ctx.config?.review?.structuredOutput === 'tool' ? { type: 'json_schema', schema: loadSchema('review-output') } : null, timeoutMs: REVIEW_TURN_TIMEOUT_MS, title,
    config: ctx.config ?? {}, extra: {
      ...routingFields(resolved.resolution, { resume: false, catalog: resolved.catalog }),
      review: { variant, targetLabel: target.label, inputMode: context.inputMode, focus },
    },
  });
  const job = await submitTurnJob(ctx, { kind: 'review', title, summary: `${label} de ${target.label}`, request });
  if (flags.background) {
    if (flags.json) ctx.json({ jobId: job.id, status: job.status, background: true }); else ctx.out(renderBackgroundStart(label, job));
    return ExitCode.OK;
  }
  const done = await waitForJob(ctx, job.id, { waitTimeoutMs: (flags['wait-timeout'] ?? DEFAULT_REVIEW_WAIT_TIMEOUT_SEC) * 1000, onLog: (line) => writeLog(ctx, line) });
  return emitReviewResult(ctx, done, { json: Boolean(flags.json) });
}
export function run(ctx, argv) { return runReviewCommand(ctx, argv, { variant: 'review' }); }
