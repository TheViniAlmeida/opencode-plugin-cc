// /opc:cancel (spec §4, §9.1).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { cancelJob, resolveJobRef } from '../lib/jobs.mjs';
import { renderCancel } from '../lib/render.mjs';

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError('USAGE', `Argumento inesperado: ${preview(positionals[1])}`);
  const target = resolveJobRef(ctx.stateDir, positionals[0] ?? null, { claudeSessionId: ctx.claudeSessionId ?? null, activeOnly: true });
  const result = await cancelJob(ctx, target.id);
  const { job, report } = result;
  if (result.ok === false) {
    const reason = result.reason ?? result.report?.reason ?? result.report?.error ?? result.code;
    const message = `Falha ao cancelar a tarefa (${result.code}): ${reason}`;
    if (flags.json) ctx.json({ error: result.code, message, report });
    else ctx.err(message);
    return ExitCode.CONNECTION;
  }
  if (flags.json) ctx.json({ jobId: job.id, status: job.status, report });
  else ctx.out(renderCancel(job, report));
  return ExitCode.OK;
}

function preview(value) { return String(value).length > 12 ? `${String(value).slice(0, 12)}…` : String(value); }
