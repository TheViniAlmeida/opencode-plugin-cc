// CLI execution context: resolved directories, effective config and redacted output helpers.
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import { redact, redactText } from './redact.mjs';
import { defaultDataDir, ensurePrivateDir, resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from './state.mjs';

export async function createContext({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  createDataDir = false,
  allowInvalidConfig = false,
  workspaceTimeoutMs,
  workspaceFallback = false,
} = {}) {
  const home = env.HOME || os.homedir();
  let dataDir;
  try {
    dataDir = resolveDataDir(env, { home });
  } catch (err) {
    if (!(createDataDir && err.code === 'DATA_DIR_UNRESOLVED')) throw err;
    dataDir = defaultDataDir({ home });
  }
  ensurePrivateDir(dataDir);
  const workspaceRoot = resolveWorkspaceRoot(path.resolve(cwd), { env, timeoutMs: workspaceTimeoutMs, fallbackOnFailure: workspaceFallback });
  ensurePrivateDir(path.join(dataDir, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, workspaceRoot));
  let loaded;
  let configError = null;
  try {
    loaded = loadConfig({ dataDir, workspaceRoot });
  } catch (err) {
    if (err.code !== 'CONFIG_INVALID' || !allowInvalidConfig) throw err;
    const configPath = err.details?.path ?? path.join(dataDir, 'config.json');
    configError = {
      scope: configPath.endsWith('.opc.json') ? 'workspace' : 'global',
      path: configPath,
      message: err.message,
      details: err.details,
    };
    loaded = {
      config: DEFAULT_CONFIG,
      warnings: ['Configuração inválida; usando os defaults. Confira com "opc config validate".'],
      hasGlobal: false,
      workspace: null,
    };
  }
  return {
    argv,
    env,
    cwd,
    stdin,
    stdout,
    stderr,
    dataDir,
    workspaceRoot,
    workspaceTimeoutMs,
    workspaceFallback,
    stateDir,
    config: loaded.config,
    configError,
    configWarnings: loaded.warnings,
    configMeta: { hasGlobal: loaded.hasGlobal, workspaceFound: loaded.workspace !== null },
    claudeSessionId: env.OPC_COMPANION_SESSION_ID ?? null,
    out(text) {
      stdout.write(redactText(String(text)));
    },
    err(text) {
      stderr.write(redactText(String(text)));
    },
    log(line) {
      stderr.write(redactText(`[opc] ${line}\n`));
    },
    json(obj) {
      stdout.write(`${JSON.stringify(redact(obj), null, 2)}\n`);
    },
  };
}

// ---- F1: connection helper for discovery/config commands ----
export async function connectApi(ctx) {
  const { ensureServer, clientFor } = await import('./server.mjs');
  const { createApi } = await import('./api.mjs');
  const { serverContext } = await import('./jobs.mjs');
  const serverCtx = serverContext(ctx);
  const server = await ensureServer(serverCtx);
  const client = clientFor(serverCtx, server);
  return { api: createApi(client), server, client };
}
// ---- end F1 ----

// ---- F2b: hooks receive `cwd` in their JSON input; state and config follow that workspace ----
import {
  ensurePrivateDir as f2bEnsurePrivateDir,
  resolveWorkspaceRoot as f2bResolveWorkspaceRoot,
  workspaceStateDir as f2bWorkspaceStateDir,
} from './state.mjs';
import { loadConfig as f2bLoadConfig } from './config.mjs';

export function contextForCwd(ctx, cwd) {
  if (!cwd) return ctx;
  if (path.resolve(cwd) === path.resolve(ctx.cwd) && ctx.workspaceTimeoutMs) return ctx;
  const workspaceRoot = f2bResolveWorkspaceRoot(cwd, { env: ctx.env, timeoutMs: ctx.workspaceTimeoutMs, fallbackOnFailure: ctx.workspaceFallback });
  if (workspaceRoot === ctx.workspaceRoot) return ctx;
  const stateDir = f2bWorkspaceStateDir(ctx.dataDir, workspaceRoot);
  f2bEnsurePrivateDir(stateDir);
  const loaded = f2bLoadConfig({ dataDir: ctx.dataDir, workspaceRoot });
  return {
    ...ctx,
    cwd,
    workspaceRoot,
    stateDir,
    config: loaded.config,
    configWarnings: loaded.warnings,
    configMeta: { hasGlobal: loaded.hasGlobal, workspaceFound: loaded.workspace !== null },
  };
}
