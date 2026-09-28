// SessionEnd has a 1.5 s total budget (spec §9.3): record the end, spawn detached reaper, exit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHookInput, readStdin } from '../lib/args.mjs';
import { contextForCwd } from '../lib/context.mjs';
import { spawnDetached } from '../lib/process.mjs';
import { redact } from '../lib/redact.mjs';

export const SESSION_END_BUDGET_MS = 900;
const REAPER_SPAWN_BUDGET_MS = 500;
const COMPANION = fileURLToPath(new URL('../opc-companion.mjs', import.meta.url));
const MAX_REAPER_LOG_BYTES = 1024 * 1024;
function prepareLog(file) {
  try { if (fs.statSync(file).size > MAX_REAPER_LOG_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* missing file is expected */ }
  fs.closeSync(fs.openSync(file, 'a', 0o600));
}

function logSpawnFailure(file, err, timedOut) {
  const diagnostic = redact({
    at: new Date().toISOString(),
    event: 'spawn_failed',
    code: timedOut ? 'SPAWN_TIMEOUT' : (err?.code ?? null),
    message: timedOut ? `reaper spawn exceeded ${REAPER_SPAWN_BUDGET_MS} ms` : (err?.message ?? String(err)),
  });
  try { fs.appendFileSync(file, `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 }); } catch { /* hook still exits successfully */ }
}

export async function run(ctx, _argv, { spawnDetachedFn = spawnDetached } = {}) {
  const enteredAt = ctx.hookEnteredAt ?? performance.now();
  const remaining = () => Math.max(0, SESSION_END_BUDGET_MS - (performance.now() - enteredAt));
  const watchdog = setTimeout(() => process.exit(0), remaining());
  watchdog.unref();
  try {
    const input = parseHookInput(await readStdin(ctx.stdin));
    if (!input.session_id) return 0;
    const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'other';
    const hctx = contextForCwd({ ...ctx, workspaceTimeoutMs: 200, workspaceFallback: true }, input.cwd || ctx.cwd);
    fs.appendFileSync(path.join(hctx.stateDir, 'sessions.log'), `${JSON.stringify({ event: 'end', sessionId: input.session_id, reason, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    const logFile = path.join(hctx.stateDir, 'reaper.log');
    prepareLog(logFile);
    const spawn = Promise.resolve().then(() => spawnDetachedFn(process.execPath, [COMPANION, 'reap', '--session', input.session_id, '--reason', reason, '--cwd', hctx.workspaceRoot], {
      cwd: hctx.workspaceRoot, env: { ...ctx.env, OPC_DATA_DIR: ctx.dataDir }, logFile,
    })).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
    let timer;
    const outcome = await Promise.race([
      spawn,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timedOut: true }), Math.min(REAPER_SPAWN_BUDGET_MS, remaining())); }),
    ]);
    clearTimeout(timer);
    if (!outcome.ok) logSpawnFailure(logFile, outcome.err, outcome.timedOut);
  } catch {
    ctx.err('[opc] não foi possível processar o fim da sessão.\n');
  } finally { clearTimeout(watchdog); }
  return 0;
}
