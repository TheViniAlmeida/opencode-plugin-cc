// opc task-resume-candidate --json: what /opc:rescue uses to ask "continue or start new" (spec §9.2).
// Adapted from openai/codex-plugin-cc (Apache-2.0); modified.
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { findResumeCandidate } from '../lib/jobs.mjs';

const KINDS = new Set(['task', 'ask', 'plan']);

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, { flags: { json: { type: 'boolean' }, cwd: { type: 'string' }, kind: { type: 'string', default: 'task' } } });
  if (!KINDS.has(flags.kind)) throw new UsageError('USAGE', '--kind deve ser task, ask ou plan');
  const candidate = findResumeCandidate(ctx.stateDir, { kind: flags.kind, claudeSessionId: ctx.claudeSessionId ?? null });
  const payload = {
    available: Boolean(candidate),
    sessionId: ctx.claudeSessionId ?? null,
    candidate: candidate
      ? { id: candidate.id, kind: candidate.kind, status: candidate.status, title: candidate.title, summary: candidate.summary, sessionID: candidate.sessionID, completedAt: candidate.completedAt, updatedAt: candidate.updatedAt }
      : null,
  };
  if (flags.json) ctx.json(payload);
  else ctx.out(candidate ? `Sessão retomável do tipo ${flags.kind} encontrada: ${candidate.id} (${candidate.status}).\n` : `Nenhuma sessão retomável do tipo ${flags.kind} foi encontrada para esta sessão Claude.\n`);
  return ExitCode.OK;
}
