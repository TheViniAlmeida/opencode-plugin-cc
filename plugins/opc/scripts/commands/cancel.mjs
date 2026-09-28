// /opc:cancel (spec §4, §9.1).
import { parseArgs } from '../lib/args.mjs';
import { ExitCode } from '../lib/opc-error.mjs';
import { cancelJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderCancel } from '../lib/render.mjs';

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  const target = resolveJobRef(ctx.stateDir, positionals[0] ?? null, { claudeSessionId: ctx.claudeSessionId ?? null, activeOnly: true });
  const { job, report } = await cancelJob(ctx, target.id);
  if (flags.json) ctx.json({ jobId: job.id, status: job.status, report });
  else ctx.out(renderCancel(job, report));
  return ExitCode.OK;
}
