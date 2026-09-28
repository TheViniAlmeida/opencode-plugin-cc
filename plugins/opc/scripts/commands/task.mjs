// /opc:task and the shared engine of /opc:ask and /opc:plan (spec §4, §6, §7, §8, §9, §10.1).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs, readRawArgs, readStdin } from '../lib/args.mjs';
import { ExitCode, OpcError, UsageError } from '../lib/opc-error.mjs';
import { connectApi } from '../lib/context.mjs';
import { buildCatalog } from '../lib/models.mjs';
import { resolveCandidates, validateSelection } from '../lib/routing.mjs';
import { buildPermissionRules, parseProfile, planPermissionSwitch } from '../lib/policy.mjs';
import { newMessageId } from '../lib/runner.mjs';
import { assertNotInsideServer, findResumeCandidate, readJob, resolveJobRef, submitTurnJob, waitForJob } from '../lib/jobs.mjs';
import { renderJobStatus, renderPermissionRequest, renderQueuedJob, renderTurnResult } from '../lib/render.mjs';
import { loadPrompt, projectContextBlock, sessionTitle, summarize } from '../lib/prompts.mjs';
export { loadPrompt, projectContextBlock, summarize, sessionTitle } from '../lib/prompts.mjs';
export const JOB_ID_RE = /^(task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}$/;
export const SESSION_REF_RE = /^ses[_0-9A-Za-z]+$/;
const RESUME_REF_RE = /^((task|review|ask|plan|sub|cmd|orch|conc|gate)-[0-9a-z]+-[0-9a-z]{6}|ses[_0-9A-Za-z]+)$/;
export const DEFAULT_TIMEOUT_SEC = 1800;
export const DEFAULT_WAIT_TIMEOUT_SEC = 540;
const KIND_SPECS = Object.freeze({
  task: { template: null, readOnly: false },
  ask: { template: 'ask.md', readOnly: true },
  plan: { template: 'plan.md', readOnly: true },
});

export const TURN_FLAGS = Object.freeze({
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  model: { type: 'string', alias: 'm' },
  agent: { type: 'string' },
  variant: { type: 'string' },
  effort: { type: 'string' },
  tier: { type: 'string' },
  write: { type: 'boolean' },
  profile: { type: 'string' },
  'resume-id': { type: 'string' },
  'resume-last': { type: 'boolean' },
  fresh: { type: 'boolean' },
  background: { type: 'boolean' },
  'prompt-file': { type: 'string' },
  timeout: { type: 'number' },
  'wait-timeout': { type: 'number' },
  'raw-args-stdin': { type: 'boolean' },
});

const RAW_TURN_FLAGS = Object.freeze({
  ...Object.fromEntries(Object.entries(TURN_FLAGS).filter(([name]) => !['resume-id', 'raw-args-stdin'].includes(name))),
  resume: { type: 'optional-string', match: RESUME_REF_RE },
});

export function normalizeResumeFlag(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      // everything after `--` is prompt text (MCP, F5): never rewrite it
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '--resume') {
      if (RESUME_REF_RE.test(argv[i + 1] ?? '')) {
        out.push('--resume-id', argv[i + 1]);
        i += 1;
      } else {
        out.push('--resume-last');
      }
    } else if (arg.startsWith('--resume=')) {
      out.push('--resume-id', arg.slice('--resume='.length));
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function buildPromptText({ userPrompt, template = null, project = null }) {
  // function replacer: `$&`, `$1`… in the user prompt must stay literal
  const body = template ? template.replace('{{USER_REQUEST}}', () => userPrompt) : userPrompt;
  const context = projectContextBlock(project);
  return context ? `${context}\n\n${body}` : body;
}

export function resolveProfile(flags, { readOnly }) {
  if (readOnly) {
    if (flags.write) throw new UsageError('READ_ONLY_KIND', 'este comando é somente leitura: --write não é aceito (use /opc:task --write)');
    if (flags.profile && flags.profile !== 'read-only') throw new UsageError('READ_ONLY_KIND', 'este comando é somente leitura: --profile não é aceito');
    return 'read-only';
  }
  if (flags.write && flags.profile) throw new UsageError('CONFLICT', '--write e --profile são mutuamente exclusivos');
  if (flags.write) return 'write';
  if (!flags.profile) return 'read-only';
  if (flags.profile === 'read-only' || flags.profile === 'write') return flags.profile;
  return `custom:${flags.profile.replace(/^custom:/, '')}`;
}

function positiveSeconds(value, flag) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new UsageError('USAGE', `${flag} exige um número positivo de segundos`);
  return value;
}

export function exitCodeForJob(job) {
  switch (job?.status) {
    case 'completed':
      return ExitCode.OK;
    case 'waiting_permission':
      return ExitCode.WAITING;
    case 'cancelled':
      return ExitCode.CANCELLED;
    case 'failed':
      return ExitCode.JOB_FAILED;
    default:
      return ExitCode.OK;
  }
}

export async function followJob(ctx, id, { waitTimeoutMs, pollMs = 500, json = false, view = 'result', streamLog = true, permissionTimeoutSec = null } = {}) {
  const onLog = streamLog && !json
    ? (line) => {
        if (line.startsWith('[')) ctx.err(`[opc] ${line.replace(/^\[[^\]]+\]\s*/, '')}\n`);
      }
    : null;
  let job;
  try {
    job = await waitForJob(ctx, id, { waitTimeoutMs, pollMs, onLog });
  } catch (err) {
    if (!(err instanceof OpcError) || err.code !== 'WAIT_TIMEOUT') throw err;
    const current = readJob(ctx.stateDir, id);
    if (json) ctx.json({ job: current, waitTimedOut: true });
    else ctx.out(`${renderJobStatus(current)}\nA tarefa continua ${current.status} após o tempo limite de espera. Acompanhe com: /opc:status ${id} --wait\n`);
    return ExitCode.WAIT_TIMEOUT;
  }
  if (json) ctx.json({ job });
  else if (job.status === 'waiting_permission') ctx.out(renderPermissionRequest(job, { timeoutSec: permissionTimeoutSec }));
  else ctx.out(view === 'status' ? renderJobStatus(job) : renderTurnResult(job));
  return exitCodeForJob(job);
}

async function readUserPrompt(ctx, flags, inlinePrompt, { resuming }) {
  if (flags['prompt-file'] && inlinePrompt) throw new UsageError('CONFLICT', 'informe o prompt inline ou com --prompt-file, não ambos');
  if (flags['prompt-file']) {
    try {
      return { text: readFileSync(resolvePath(ctx.cwd, flags['prompt-file']), 'utf8'), isDefault: false };
    } catch (err) {
      throw new UsageError('PROMPT_FILE', `não foi possível ler --prompt-file ${String(flags['prompt-file']).slice(0, 12)}…: ${err.code ?? 'erro de leitura'}`);
    }
  }
  if (inlinePrompt) return { text: inlinePrompt, isDefault: false };
  if (!flags['raw-args-stdin'] && ctx.stdin && !ctx.stdin.isTTY && !ctx.stdin.readableEnded) {
    const piped = await readStdin(ctx.stdin);
    if (piped.trim()) return { text: piped, isDefault: false };
  }
  if (resuming) return { text: loadPrompt('continue.md'), isDefault: true };
  throw new UsageError('NO_PROMPT', 'informe um prompt (inline, --prompt-file ou stdin) ou use --resume');
}

async function parseTurnArgs(ctx, argv) {
  const raw = await readRawArgs(argv, RAW_TURN_FLAGS, { stdin: ctx.stdin });
  const { flags, positionals } = parseArgs(normalizeResumeFlag(raw.argv), { flags: TURN_FLAGS, allowPositionals: true });
  if (raw.text && positionals.length) throw new UsageError('CONFLICT', 'informe o prompt inline ou por --raw-args-stdin, não ambos');
  return { flags, inlinePrompt: raw.text || positionals.join(' ') };
}

function resolveResumeSession(ctx, flags, kind) {
  if (flags['resume-id']) {
    const ref = flags['resume-id'];
    if (SESSION_REF_RE.test(ref)) return ref;
    const job = resolveJobRef(ctx.stateDir, ref);
    if (!job.sessionID) throw new UsageError('NO_SESSION', `a tarefa ${job.id} não tem uma sessão OpenCode para retomar`);
    return job.sessionID;
  }
  if (flags['resume-last']) {
    if (!ctx.claudeSessionId) {
      throw new UsageError('RESUME_NEEDS_ID', '--resume sem id exige uma sessão Claude (OPC_COMPANION_SESSION_ID); informe --resume <job-id|session-id>');
    }
    const candidate = findResumeCandidate(ctx.stateDir, { kind, claudeSessionId: ctx.claudeSessionId });
    if (!candidate) throw new UsageError('NOTHING_TO_RESUME', `não há tarefa ${kind} concluída com sessão nesta sessão Claude`);
    return candidate.sessionID;
  }
  return null;
}

function statusPollOverride(env) {
  const value = Number(env?.OPC_STATUS_POLL_MS);
  return Number.isFinite(value) && value > 0 ? { statusPollMs: value } : {};
}

function hostPort(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function runKindCommand(ctx, argv, kind) {
  const spec = KIND_SPECS[kind];
  const { flags, inlinePrompt } = await parseTurnArgs(ctx, argv);
  const resuming = Boolean(flags['resume-id'] || flags['resume-last']);
  if (flags.fresh && resuming) throw new UsageError('CONFLICT', '--resume e --fresh são mutuamente exclusivos');
  if (flags.variant && flags.effort) throw new UsageError('CONFLICT', '--variant e --effort são mutuamente exclusivos; informe apenas uma opção');
  const profile = resolveProfile(flags, spec);
  assertNotInsideServer(ctx.env);
  const { text: userPrompt, isDefault } = await readUserPrompt(ctx, flags, inlinePrompt, { resuming });
  const turnTimeoutSec = positiveSeconds(flags.timeout, '--timeout') ?? DEFAULT_TIMEOUT_SEC;
  const waitTimeoutSec = positiveSeconds(flags['wait-timeout'], '--wait-timeout') ?? DEFAULT_WAIT_TIMEOUT_SEC;
  const config = ctx.config ?? {};
  const policy = config.policy ?? {};

  const { api, server } = await connectApi(ctx);
  const catalog = buildCatalog(await api.providers());
  const opencodeConfig = await api.getConfig();
  const { candidates, warnings } = resolveCandidates({ kind, flags: { model: flags.model, tier: flags.tier }, config, catalog, opencodeConfig });
  for (const warning of warnings) ctx.err(`[opc] aviso: ${warning}\n`);
  const candidate = candidates[0];
  const agentName = flags.agent ?? config.defaultAgent ?? null;
  const agents = agentName ? await api.agents() : [];
  let variant = flags.variant ?? flags.effort ?? null;
  if (!variant && config.defaultVariant) {
    const available = catalog.byFull.get(candidate.full)?.variants ?? [];
    if (available.includes(config.defaultVariant)) variant = config.defaultVariant;
    else ctx.err(`[opc] aviso: defaultVariant "${config.defaultVariant}" não está disponível para ${candidate.full}; ignorada\n`);
  }
  const selection = validateSelection({ candidate, variant, agentName, agents, catalog, policy });
  const rules = buildPermissionRules(profile, { policy, permissionProfiles: config.permissionProfiles ?? {}, deniedAgentGlobs: policy.agents?.deny ?? [] });
  const sessionID = resolveResumeSession(ctx, flags, kind);
  let patchPermission = null;
  if (sessionID) {
    const session = await api.getSession(sessionID);
    if (planPermissionSwitch(session?.permission, rules) === 'patch') patchPermission = rules;
  }
  const template = spec.template ? loadPrompt(spec.template) : null;
  const text = buildPromptText({ userPrompt, template, project: config.project });
  const summary = isDefault ? 'continue' : summarize(userPrompt);
  const profileKind = parseProfile(profile).kind;
  const permissionTimeoutSec = policy.permissionTimeoutSec ?? 600;
  const request = {
    kind,
    profileKind,
    ...(sessionID ? { sessionID } : { newSession: { title: sessionTitle(kind, summary), permission: rules } }),
    ...(patchPermission ? { patchPermission } : {}),
    childPermission: profileKind === 'read-only' ? null : rules,
    parts: [{ type: 'text', text }],
    model: { providerID: candidate.providerID, modelID: candidate.modelID },
    agent: selection.agent,
    variant: selection.variant,
    format: null,
    messageID: newMessageId(),
    timeoutMs: turnTimeoutSec * 1000,
    fallbackCfg: config.routing?.fallback ?? {},
    permissionTimeoutMs: permissionTimeoutSec * 1000,
    ...statusPollOverride(ctx.env),
  };
  const job = await submitTurnJob(ctx, {
    kind,
    title: `opc ${kind}`,
    summary,
    request: { ...request, profile, title: request.newSession?.title ?? null, modelFull: candidate.full },
    fields: {
      sessionID,
      model: candidate.full,
      agent: selection.agent,
      variant: selection.variant,
      permissionProfile: profile,
      serverUrlRef: hostPort(server.url),
    },
    queuedLog: `Na fila: ${kind} (${candidate.full}, perfil ${profile}${sessionID ? ', retomando sessão' : ''}).`,
  });
  if (flags.background) {
    if (flags.json) ctx.json({ jobId: job.id, status: 'queued', kind, model: candidate.full });
    else ctx.out(renderQueuedJob(job));
    return ExitCode.OK;
  }
  ctx.err(`[opc] tarefa ${job.id} iniciada (${candidate.full}); acompanhe com /opc:status ${job.id}\n`);
  return followJob(ctx, job.id, { waitTimeoutMs: waitTimeoutSec * 1000, json: flags.json, permissionTimeoutSec });
}

export async function run(ctx, argv) {
  return runKindCommand(ctx, argv, 'task');
}
