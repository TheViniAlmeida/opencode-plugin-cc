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
  const workspaceRoot = resolveWorkspaceRoot(path.resolve(cwd));
  ensurePrivateDir(path.join(dataDir, 'state'));
  const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, workspaceRoot));
  let loaded;
  try {
    loaded = loadConfig({ dataDir, workspaceRoot });
  } catch (err) {
    const args = argv.map(String);
    const validatingConfig = args[0] === 'validate' || (args[0] === 'config' && args[1] === 'validate');
    const stoppingServer = args.includes('--stop-server');
    if (err.code !== 'CONFIG_INVALID' || (!validatingConfig && !stoppingServer)) throw err;
    // Let `config validate` render the structured CONFIG_INVALID details itself.
    loaded = {
      config: DEFAULT_CONFIG,
      warnings: stoppingServer ? ['Config inválida; usando defaults para parar o servidor.'] : [],
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
    stateDir,
    config: loaded.config,
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
