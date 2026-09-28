// Detached reaper spawned by SessionEnd (spec §9.3). Output goes to <stateDir>/reaper.log.
import { parseArgs } from '../lib/args.mjs';
import { contextForCwd } from '../lib/context.mjs';
import { UsageError } from '../lib/opc-error.mjs';
import { ACTIVE_STATUSES, cancelJob, listJobs, liveActiveJobs, withServerLock } from '../lib/jobs.mjs';
import { redactText } from '../lib/redact.mjs';
import { liveClaudeSessions, removeClaudeSession } from '../lib/state.mjs';
import { readServerRecord, stopServer } from '../lib/server.mjs';

export const KEEP_SERVER_REASONS = new Set(['clear', 'resume']);
export const DEFAULT_GRACE_MS = 60_000;
export const DEFAULT_CANCEL_CAP_MS = 15_000;
const FLAGS = { session: { type: 'string' }, reason: { type: 'string', default: 'other' }, cwd: { type: 'string' }, json: { type: 'boolean' } };

export function decideServerFate({ record, attached = false, liveSessions = [], activeJobs = [] }) {
  if (attached) return 'keep:attached';
  if (!record) return 'keep:no-server';
  if (record.spawnedBy !== 'opc') return 'keep:not-plugin-spawned';
  if (liveSessions.length) return 'keep:live-sessions';
  if (activeJobs.length) return 'keep:active-jobs';
  return 'stop';
}
export const KEEP_DECISIONS = Object.freeze(['keep:reason-clear', 'keep:reason-resume', 'keep:attached', 'keep:no-server', 'keep:not-plugin-spawned', 'keep:live-sessions', 'keep:active-jobs', 'stop']);
function envMs(env, name, fallback) { const value = Number(env[name]); return env[name] !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function log(ctx, event, fields) { ctx.out(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`); }

async function cancelSessionJobs(ctx, sessionId, capMs, cancelJobFn = cancelJob) {
  const ids = listJobs(ctx.stateDir, { all: true }).filter((job) => job.claudeSessionId === sessionId && ACTIVE_STATUSES.includes(job.status)).map((job) => job.id);
  if (!ids.length) return { ids, timedOut: false, failed: [] };
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve('cap'), capMs); });
  const settled = new Set();
  const failed = new Set();
  const attempts = ids.map(async (jobId) => {
    try {
      const result = await cancelJobFn(ctx, jobId);
      settled.add(jobId);
      if (result?.ok === false) {
        failed.add(jobId);
        log(ctx, 'cancel_failed', { sessionId, jobId, code: redactText(String(result.code ?? 'CANCEL_FAILED')) });
      }
      else log(ctx, 'cancelled', { sessionId, jobId });
    } catch (err) {
      settled.add(jobId);
      failed.add(jobId);
      log(ctx, 'cancel_failed', { sessionId, jobId, code: redactText(String(err?.code ?? 'CANCEL_FAILED')) });
    }
  });
  const outcome = await Promise.race([Promise.all(attempts).then(() => 'done'), cap]);
  clearTimeout(timer);
  if (outcome === 'cap') {
    for (const jobId of ids) {
      if (settled.has(jobId)) continue;
      failed.add(jobId);
      log(ctx, 'cancel_failed', { sessionId, jobId, code: 'CANCEL_TIMEOUT' });
    }
  }
  return { ids, timedOut: outcome === 'cap', failed: [...failed] };
}

export async function run(ctx, argv, dependencies = {}) {
  const { flags } = parseArgs(argv, { flags: FLAGS });
  if (!flags.session) throw new UsageError('USAGE', 'reap exige --session <id>.');
  const rctx = contextForCwd(ctx, flags.cwd ?? ctx.cwd), sessionId = flags.session, reason = flags.reason || 'other';
  log(rctx, 'start', { sessionId, reason });
  try {
    const cancelled = await cancelSessionJobs(rctx, sessionId, envMs(ctx.env, 'OPC_REAP_CANCEL_CAP_MS', DEFAULT_CANCEL_CAP_MS), dependencies.cancelJobFn);
    await removeClaudeSession(rctx.stateDir, sessionId);
    if (KEEP_SERVER_REASONS.has(reason)) { log(rctx, 'decision', { sessionId, reason, decision: `keep:reason-${reason}` }); return 0; }
    await delay(envMs(ctx.env, 'OPC_REAP_GRACE_MS', DEFAULT_GRACE_MS));
    const outcome = await withServerLock(rctx, async () => {
      // A job whose cancel failed or timed out keeps the server even if its worker looks lost:
      // its OpenCode session may still be running a turn.
      const blocking = () => {
        const live = liveActiveJobs(rctx.stateDir);
        const liveIds = new Set(live.map((job) => job.id));
        return [...live, ...cancelled.failed.filter((id) => !liveIds.has(id)).map((id) => ({ id }))];
      };
      const activeJobs = blocking();
      const decision = decideServerFate({
        record: (dependencies.readServerRecordFn ?? readServerRecord)(rctx.stateDir),
        attached: Boolean(rctx.env.OPC_SERVER_URL),
        liveSessions: liveClaudeSessions(rctx.stateDir),
        activeJobs,
      });
      if (decision !== 'stop') return { decision };
      const result = await (dependencies.stopServerFn ?? stopServer)({ ...rctx, hasActiveJobs: () => blocking().length > 0 }, { lockHeld: true });
      return { decision, result };
    }, { purpose: 'reaper' });
    log(rctx, 'decision', { sessionId, reason, ...outcome });
  } catch (err) {
    log(rctx, 'error', { sessionId, reason, code: err?.code ?? null, message: err?.message ?? String(err) });
  }
  return 0;
}
