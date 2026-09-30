// /opc:cancel (spec §4, §9.1).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { cancelGroup, cancelJob, GROUP_ROLE, resolveJobRef } from '../lib/jobs.mjs';
import { renderCancel } from '../lib/render.mjs';

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' } }, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError('USAGE', `Argumento inesperado: ${preview(positionals[1])}`);
  const target = resolveJobRef(ctx.stateDir, positionals[0] ?? null, { claudeSessionId: ctx.claudeSessionId ?? null, activeOnly: true });
  const groupExit = await cancelForGroup(ctx, target, flags);
  if (groupExit !== null) return groupExit;
  const result = await cancelJob(ctx, target.id);
  const { job, report } = result;
  if (result.ok === false) {
    const reason = result.reason ?? result.report?.reason ?? result.report?.error ?? result.code;
    const message = `Falha ao cancelar a tarefa (${result.code}): ${reason}`;
    if (flags.json) ctx.json({ error: result.code, message, report });
    else ctx.err(message);
    return ExitCode.CONNECTION;
  }
  if (flags.json) ctx.json({ jobId: job.id, status: job.status, report, ...(report?.deferred ? { pending: true } : {}) });
  else ctx.out(renderCancel(job, report));
  return ExitCode.OK;
}

export async function cancelForGroup(ctx, job, flags) {
  if (job?.role !== GROUP_ROLE) return null;
  const { group, cancelledMembers, deferredMembers = [], failedMembers = [], ok = true, deferred = false } = await cancelGroup(ctx, job.id);
  if (failedMembers.length || !ok) {
    if (flags.json) ctx.json({ group, cancelledMembers, failedMembers, error: 'CANCEL_FAILED' });
    else ctx.err(`Falha ao cancelar o grupo ${group.id}; membros que falharam: ${failedMembers.join(', ') || group.id}`);
    return ExitCode.CONNECTION;
  }
  if (deferred) {
    // Intent accepted; the coordinator finishes the cancellation before prompting the pending members.
    if (flags.json) ctx.json({ group, cancelledMembers, deferredMembers, failedMembers, pending: true });
    else ctx.out(`# Cancelamento do grupo ${group.id} pendente\n\nMembros cancelados: ${cancelledMembers.join(', ') || '(nenhum)'}\nMembros com cancelamento pendente (sessão em criação): ${deferredMembers.join(', ')}\n\nO coordenador conclui o cancelamento antes de enviar o prompt. Confirme com \`/opc:status ${group.id} --wait\`.\n`);
    return ExitCode.OK;
  }
  if (flags.json) ctx.json({ group, cancelledMembers, failedMembers });
  else ctx.out(`# Grupo ${group.id} cancelado\n\nMembros cancelados: ${cancelledMembers.join(', ') || '(nenhum ativo)'}\n`);
  return ExitCode.OK;
}

function preview(value) { return String(value).length > 12 ? `${String(value).slice(0, 12)}…` : String(value); }
