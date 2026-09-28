// /opc:result (spec §4).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { NotFoundError, UsageError } from '../lib/opc-error.mjs';
import { isActive, isTerminal, listJobs, reconcileJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderTurnResult } from '../lib/render.mjs';
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
    job = jobs.find(isTerminal) ?? null;
    if (!job) {
      const active = jobs.find(isActive);
      if (active) throw stillRunning(active);
      throw new NotFoundError('NO_FINISHED_JOB', 'ainda não há tarefa concluída nesta sessão do Claude');
    }
  }
  if (isActive(job)) throw stillRunning(job);
  if (flags.json) ctx.json({ job });
  else ctx.out(renderTurnResult(job));
  return exitCodeForJob(job);
}

function preview(value) { return String(value).length > 12 ? `${String(value).slice(0, 12)}…` : String(value); }
