// /opc:status (spec §4, §9.1).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { GROUP_ROLE, isActive, listJobs, listGroupMembers, readJobProgress, reconcileJob, resolveJobRef, topLevelJobs, waitForJob } from '../lib/jobs.mjs';
import { renderGroupStatus, renderJobStatus, renderStatusList } from '../lib/render.mjs';
import { exitCodeForJob, followJob } from './task.mjs';

const FLAGS = {
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  wait: { type: 'boolean' },
  'timeout-ms': { type: 'number', default: 240000 },
  'poll-interval-ms': { type: 'number', default: 2000 },
  all: { type: 'boolean' },
};

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: FLAGS, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError('USAGE', `Argumento inesperado: ${preview(positionals[1])}`);
  for (const name of ['timeout-ms', 'poll-interval-ms']) {
    if (flags[name] < 0) throw new UsageError('USAGE', `--${name} não pode ser negativo.`);
  }
  const ref = positionals[0] ?? null;
  if (flags.wait && !ref) throw new UsageError('USAGE', '`status --wait` exige um identificador de tarefa');
  if (ref) {
    const job = await reconcileJob(ctx.stateDir, resolveJobRef(ctx.stateDir, ref));
    const groupExit = await statusForGroup(ctx, job, flags);
    if (groupExit !== null) return groupExit;
    if (flags.wait) {
      return followJob(ctx, job.id, {
        waitTimeoutMs: flags['timeout-ms'],
        pollMs: Math.max(100, flags['poll-interval-ms']),
        json: flags.json,
        view: 'status',
        streamLog: false,
      });
    }
    const progress = readJobProgress(ctx.stateDir, job.id, 4);
    if (flags.json) ctx.json({ job, progress });
    else ctx.out(renderJobStatus(job, { progress }));
    return ExitCode.OK;
  }
  const jobs = [];
  for (const job of listJobs(ctx.stateDir, { claudeSessionId: ctx.claudeSessionId ?? null, all: flags.all })) {
    jobs.push(await reconcileJob(ctx.stateDir, job));
  }
  const visibleJobs = topLevelJobs(jobs);
  const progressById = Object.fromEntries(visibleJobs.filter(isActive).map((j) => [j.id, readJobProgress(ctx.stateDir, j.id, 4)]));
  if (flags.json) ctx.json({ jobs: visibleJobs, progress: progressById });
  else ctx.out(renderStatusList(visibleJobs, { maxJobs: flags.all ? Infinity : 8, progressById }));
  return ExitCode.OK;
}

export async function statusForGroup(ctx, job, flags) {
  if (job?.role !== GROUP_ROLE) return null;
  const final = flags.wait
    ? await waitForJob(ctx, job.id, {
      waitTimeoutMs: flags['timeout-ms'] ?? 240000,
      pollMs: flags['poll-interval-ms'] ?? 2000,
      onLog: (line) => ctx.err(line.endsWith('\n') ? line : `${line}\n`),
    })
    : job;
  const members = listGroupMembers(ctx.stateDir, job.id);
  if (flags.json) ctx.json({ group: final, members });
  else ctx.out(renderGroupStatus(final, members));
  return flags.wait ? exitCodeForJob(final) : ExitCode.OK;
}

function preview(value) { return String(value).length > 12 ? `${String(value).slice(0, 12)}…` : String(value); }
