// Adapted from openai/codex-plugin-cc (Apache-2.0); modified: opc session registry, OPC_DATA_DIR export
// and the optional delegation reminder.
import fs from 'node:fs';
import path from 'node:path';
import { parseHookInput, readStdin } from '../lib/args.mjs';
import { contextForCwd } from '../lib/context.mjs';
import { loadConfig, delegationAutoEnabled } from '../lib/config.mjs';
import { delegationReminder } from '../lib/render.mjs';
import { getProcessIdentity } from '../lib/process.mjs';
import { registerClaudeSession } from '../lib/state.mjs';

// O texto final vive em render.mjs; mantém o nome exportado da F2b.
export const DELEGATION_REMINDER = delegationReminder();

export function sessionStartContext({ dataDir, workspaceRoot }) {
  try {
    const { global, workspace } = loadConfig({ dataDir, workspaceRoot });
    return delegationAutoEnabled({ global, workspace }) ? delegationReminder() : null;
  } catch {
    return null; // configuração ilegível nunca impede o início da sessão
  }
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

export function writeEnvExports(envFile, vars) {
  if (!envFile) return 0;
  const lines = Object.entries(vars).filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`);
  if (lines.length) fs.appendFileSync(envFile, lines.join(''), { encoding: 'utf8', mode: 0o600 });
  return lines.length;
}

export async function run(ctx) {
  try {
    const input = parseHookInput(await readStdin(ctx.stdin));
    writeEnvExports(ctx.env.CLAUDE_ENV_FILE, {
      OPC_COMPANION_SESSION_ID: input.session_id,
      OPC_COMPANION_TRANSCRIPT_PATH: input.transcript_path,
      CLAUDE_PLUGIN_DATA: ctx.env.CLAUDE_PLUGIN_DATA,
      OPC_DATA_DIR: ctx.dataDir,
    });
    const hctx = contextForCwd(ctx, input.cwd || ctx.cwd);
    if (input.session_id) {
      const identity = getProcessIdentity(process.ppid);
      await registerClaudeSession(hctx.stateDir, {
        sessionId: input.session_id, pid: process.ppid,
        pidStartTime: identity?.startTime ?? null,
        pidComm: identity?.cmdline?.[0] ? path.basename(identity.cmdline[0]) : null,
        source: input.source ?? null, startedAt: new Date().toISOString(),
      });
    }
    const additionalContext = sessionStartContext({ dataDir: ctx.dataDir, workspaceRoot: hctx.workspaceRoot });
    if (additionalContext) {
      ctx.out(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
    }
  } catch {
    ctx.err('[opc] não foi possível processar o início da sessão.\n');
  }
  return 0;
}
