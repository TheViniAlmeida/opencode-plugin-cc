// /opc:result (spec §4).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { NotFoundError, UsageError } from '../lib/opc-error.mjs';
import { ACTIVE_STATUSES, GROUP_ROLE, isActive, isTerminal, listGroupMembers, listJobs, reconcileJob, resolveJobRef, topLevelJobs } from '../lib/jobs.mjs';
import { renderCommandResult, renderGroupResult, renderReviewJob, renderTurnResult } from '../lib/render.mjs';
import { exitCodeForJob } from './task.mjs';

const stillRunning = (job) => {
  const status = job.status === 'queued' ? 'na fila' : job.status === 'waiting_permission' ? 'aguardando permissão' : 'em execução';
  return new UsageError('JOB_ACTIVE', `a tarefa ${job.id} ainda está ${status}${job.status === 'waiting_permission' ? ' (aguarda uma decisão: /opc:permissions list)' : ''}; consulte /opc:status ${job.id} --wait`);
};

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError('USAGE', `Argumento inesperado: ${preview(positionals[1])}`);
  const ref = positionals[0] ?? null;
  let job;
  if (ref) {
    job = await reconcileJob(ctx.stateDir, resolveJobRef(ctx.stateDir, ref));
  } else {
    const jobs = [];
    for (const candidate of listJobs(ctx.stateDir, { claudeSessionId: ctx.claudeSessionId ?? null })) {
      jobs.push(await reconcileJob(ctx.stateDir, candidate));
    }
    job = topLevelJobs(jobs).find(isTerminal) ?? null;
    if (!job) {
      const active = topLevelJobs(jobs).find(isActive);
      if (active) throw stillRunning(active);
      throw new NotFoundError('NO_FINISHED_JOB', 'ainda não há tarefa concluída nesta sessão do Claude');
    }
  }
  const special = resultForGroupOrCommand(ctx, job, flags);
  if (special !== null) return special;
  if (isActive(job)) throw stillRunning(job);
  if (job.kind === 'review') {
    const rendered = renderReviewJob(job);
    if (flags.json) ctx.json({ jobId: job.id, status: job.status, review: job.result?.structured ?? null, rendered });
    else ctx.out(rendered);
    return exitCodeForJob(job);
  }
  if (flags.json) ctx.json({ job });
  else ctx.out(renderTurnResult(job));
  return exitCodeForJob(job);
}

export function resultForGroupOrCommand(ctx, job, flags) {
  const isGroup = job?.role === GROUP_ROLE;
  if (!isGroup && job?.kind !== 'cmd') return null;
  if (ACTIVE_STATUSES.includes(job.status)) {
    throw new UsageError('JOB_ACTIVE', `o ${isGroup ? 'grupo' : 'job'} ${job.id} ainda está em execução (${job.phase ?? job.status}); use /opc:status ${job.id} --wait`);
  }
  if (isGroup) {
    const members = listGroupMembers(ctx.stateDir, job.id);
    if (flags.json) ctx.json({ group: job, members });
    else ctx.out(job.rendered ?? renderGroupResult(job, members));
  } else if (flags.json) {
    ctx.json({ job });
  } else {
    ctx.out(job.rendered ?? renderCommandResult(job.result ?? commandResultFromJob(job)));
  }
  return exitCodeForJob(job);
}

// A job that failed before its worker wrote a result (e.g. the worker never started): render its stored failure.
function commandResultFromJob(job) {
  return {
    status: job.status, command: job.request?.command ?? '?', argumentsPreview: job.request?.argumentsPreview ?? '',
    sessionID: job.sessionID ?? null, model: job.model ?? null, agent: job.agent ?? null, finalText: '',
    error: job.errorMessage ? { name: job.errorType ?? job.errorCode ?? 'Error', message: job.errorMessage } : null,
  };
}

function preview(value) { return String(value).length > 12 ? `${String(value).slice(0, 12)}…` : String(value); }
