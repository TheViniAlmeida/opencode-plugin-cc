import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError, NotFoundError } from '../lib/opc-error.mjs';
import { isValidJobId, readJobProgress } from '../lib/jobs.mjs';
import { renderMonitor, MONITOR_ACTIVE } from '../lib/render.mjs';
import { abortableSleep } from '../lib/routing.mjs';
import { maskDeep, redactText } from '../lib/redact.mjs';

export const CLEAR_SCREEN = '\x1b[2J\x1b[H';

const FLAGS = {
  flags: {
    job: { type: 'string' },
    once: { type: 'boolean' },
    json: { type: 'boolean' },
    color: { type: 'string', default: 'auto' },
    interval: { type: 'number', default: 1000 },
    cwd: { type: 'string' },
  },
};

const preview = (value) => {
  const text = String(value ?? '');
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
};

export function normalizePending(pending) {
  if (!pending) return [];
  const list = Array.isArray(pending) ? pending : [pending];
  return list.map((r) => {
    const isQuestion = r.type === 'question' || Array.isArray(r.questions);
    const what = isQuestion
      ? (r.questions ?? []).map((q) => q.question ?? q.header ?? '').filter(Boolean).join(' | ') || 'pergunta'
      : r.permission ?? r.tool ?? 'permissão';
    const raw = r.patterns ?? r.pattern ?? [];
    return { id: r.id ?? r.requestID ?? '?', kind: isQuestion ? 'question' : 'permission', what, patterns: Array.isArray(raw) ? raw : [raw] };
  });
}

export function toMonitorEntry(job, { log = [] } = {}) {
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  const active = MONITOR_ACTIVE.includes(job.status);
  const limit = Math.max(1, Number(job.attemptLimit ?? 1), attempts.length);
  const current = active ? Math.min(attempts.length + 1, limit) : Math.max(1, attempts.length);
  return {
    id: job.id,
    kind: job.kind,
    title: job.title ?? null,
    status: job.status,
    phase: job.phase ?? null,
    model: job.model ?? null,
    groupId: job.groupId ?? null,
    role: job.role ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    errorType: job.errorType ?? null,
    errorMessage: job.errorMessage ?? null,
    attempts,
    attempt: { current, limit },
    pending: normalizePending(job.pendingRequest),
    log,
  };
}

function orderWithGroups(list) {
  const ids = new Set(list.map((j) => j.id));
  const out = [];
  for (const job of list) {
    if (job.groupId && ids.has(job.groupId)) continue;
    out.push(job);
    for (const member of list) if (member.groupId === job.id) out.push(member);
  }
  return out;
}

export function selectJobs(jobs, { focusId = null, limit = 12 } = {}) {
  const byCreated = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  if (focusId) {
    const focus = jobs.filter((j) => j.id === focusId);
    const members = jobs.filter((j) => j.groupId === focusId).sort(byCreated);
    return [...focus, ...members];
  }
  const ids = new Set(jobs.map((j) => j.id));
  const topLevel = jobs.filter((j) => !j.groupId || !ids.has(j.groupId));
  const active = topLevel.filter((j) => MONITOR_ACTIVE.includes(j.status)).sort(byCreated);
  const endedAt = (j) => String(j.completedAt ?? j.updatedAt ?? j.createdAt ?? '');
  const terminal = topLevel.filter((j) => !MONITOR_ACTIVE.includes(j.status)).sort((a, b) => endedAt(b).localeCompare(endedAt(a)));
  const recent = terminal.slice(0, Math.max(0, limit - active.length));
  const visibleTop = [...active, ...recent];
  const visibleIds = new Set(visibleTop.map((j) => j.id));
  const members = jobs.filter((j) => j.groupId && visibleIds.has(j.groupId));
  return orderWithGroups([...visibleTop, ...members]);
}

function safeReadJson(file, warnings, { missingIsSilent = true } = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && missingIsSilent) return null;
    if (err instanceof SyntaxError) return null;
    warnings.push(`aviso: não foi possível ler ${path.basename(file)}: ${err.code ?? 'ERRO'}`);
    return null;
  }
}

// Leitura crua e sem efeitos colaterais: nunca repara, reconcilia ou grava estado.
export function readJobRecords(stateDir, warnings = []) {
  const byId = new Map();
  const state = safeReadJson(path.join(stateDir, 'state.json'), warnings);
  for (const entry of Array.isArray(state?.jobs) ? state.jobs : []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const jobsDir = path.join(stateDir, 'jobs');
  let files = [];
  try {
    files = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.input.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`aviso: não foi possível ler ${path.basename(jobsDir)}: ${err.code ?? 'ERRO'}`);
  }
  for (const file of files) {
    const fileId = file.slice(0, -'.json'.length);
    if (!isValidJobId(fileId)) continue;
    const record = safeReadJson(path.join(jobsDir, file), warnings);
    if (record && isValidJobId(record.id) && record.id === fileId) byId.set(record.id, { ...(byId.get(record.id) ?? {}), ...record });
  }
  return [...byId.values()];
}

export function pickJobId(records, ref) {
  const exact = records.find((j) => j.id === ref);
  if (exact) return exact.id;
  const matches = records.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) throw new NotFoundError('NOT_FOUND', `job não encontrado: ${preview(ref)}`);
  throw new UsageError('AMBIGUOUS_JOB', `prefixo ambíguo "${preview(ref)}".`);
}

export function buildMonitorSnapshot(stateDir, { jobId = null, now = Date.now(), logLines = 3, focusLogLines = 10, limit = 12 } = {}) {
  const warnings = [];
  const records = readJobRecords(stateDir, warnings);
  const selected = selectJobs(records, { focusId: jobId, limit });
  const jobs = [];
  for (const job of selected) {
    let log = [];
    try {
      log = readJobProgress(stateDir, job.id, job.id === jobId ? focusLogLines : logLines);
    } catch (err) {
      warnings.push(`aviso: não foi possível ler ${job.id}.log: ${err.code ?? 'ERRO'}`);
    }
    jobs.push(toMonitorEntry(job, { log }));
  }
  const snapshot = {
    now,
    focus: jobId,
    jobs,
  };
  if (warnings.length) snapshot.warnings = warnings;
  return snapshot;
}

export async function monitorLoop({ read, render, write, intervalMs = 1000, sleep = abortableSleep, signal, once = false, clear = false }) {
  let frames = 0;
  for (;;) {
    const snapshot = await read();
    write(`${clear ? CLEAR_SCREEN : ''}${render(snapshot)}`);
    frames += 1;
    if (once || signal?.aborted) break;
    const slept = await sleep(intervalMs, signal);
    if (!slept || signal?.aborted) break;
  }
  return frames;
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, FLAGS);
  if (!['auto', 'always', 'never'].includes(flags.color)) {
    throw new UsageError('USAGE', `--color deve ser auto, always ou never (recebido: "${preview(flags.color)}")`);
  }
  if (!Number.isFinite(flags.interval) || flags.interval < 100) {
    throw new UsageError('USAGE', '--interval deve ser um número de milissegundos >= 100');
  }
  const jobId = flags.job ? pickJobId(readJobRecords(ctx.stateDir), flags.job) : null;
  const read = () => buildMonitorSnapshot(ctx.stateDir, { jobId, now: Date.now() });
  if (flags.json) {
    const snapshot = read();
    ctx.json(maskDeep(snapshot));
    return (snapshot.warnings ?? []).some((warning) => warning.includes('jobs:')) ? ExitCode.CONNECTION : ExitCode.OK;
  }
  const tty = Boolean(ctx.stdout.isTTY);
  const color = flags.color === 'always' || (flags.color === 'auto' && tty && !ctx.env.NO_COLOR);
  const once = flags.once === true;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await monitorLoop({
      read,
      render: (snapshot) => renderMonitor(snapshot, { color }),
      write: (text) => ctx.stdout.write(maskDeep(text)),
      intervalMs: flags.interval,
      signal: controller.signal,
      once,
      clear: tty && !once,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  const snapshot = read();
  return (snapshot.warnings ?? []).some((warning) => warning.includes('jobs:')) ? ExitCode.CONNECTION : ExitCode.OK;
}
