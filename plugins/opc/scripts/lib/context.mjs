// CLI execution context: resolved directories, effective config and redacted output helpers.
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import { redact, redactText } from './redact.mjs';
import { defaultDataDir, ensurePrivateDir, resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from './state.mjs';
import { ensureServer } from './server.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';
import { EventHub } from './sse.mjs';
import { buildCatalog } from './models.mjs';
import { assertAgentUsable, buildPermissionRules } from './policy.mjs';
import { resolveCandidates, validateSelection } from './routing.mjs';
import { UsageError } from './opc-error.mjs';

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

export function contextForCwd(ctx, cwd, { allowInvalidConfig = false } = {}) {
  if (!cwd) return ctx;
  if (path.resolve(cwd) === path.resolve(ctx.cwd) && ctx.workspaceTimeoutMs) return ctx;
  const workspaceRoot = f2bResolveWorkspaceRoot(cwd, { env: ctx.env, timeoutMs: ctx.workspaceTimeoutMs, fallbackOnFailure: ctx.workspaceFallback });
  if (workspaceRoot === ctx.workspaceRoot) return ctx;
  const stateDir = f2bWorkspaceStateDir(ctx.dataDir, workspaceRoot);
  f2bEnsurePrivateDir(stateDir);
  let loaded;
  let configError = null;
  try {
    loaded = f2bLoadConfig({ dataDir: ctx.dataDir, workspaceRoot });
  } catch (err) {
    if (err.code !== 'CONFIG_INVALID' || !allowInvalidConfig) throw err;
    configError = err;
    loaded = { config: DEFAULT_CONFIG, warnings: ['Configuração inválida; usando os defaults.'], hasGlobal: false, workspace: null };
  }
  return {
    ...ctx,
    cwd,
    workspaceRoot,
    stateDir,
    config: loaded.config,
    configError,
    configWarnings: loaded.warnings,
    configMeta: { hasGlobal: loaded.hasGlobal, workspaceFound: loaded.workspace !== null },
  };
}

// --- F3: connection, discovery and policy helpers shared by the F3 commands ------------

// respawn: true uses the foreground connection with server recovery. Workers do not
// bring up another server mid-turn and use a client without onServerDown.
export async function openApi(ctx, { withHub = false, respawn = true } = {}) {
  let server;
  let client;
  let api;
  if (respawn) {
    ({ api, server, client } = await connectApi(ctx));
  } else {
    const { serverContext } = await import('./jobs.mjs');
    server = await ensureServer(serverContext(ctx));
    client = createClient({
      baseUrl: server.url,
      password: server.password,
      directory: ctx.workspaceRoot,
      requestTimeoutMs: (ctx.config?.server?.requestTimeoutSec ?? 30) * 1000,
    });
    api = createApi(client);
  }
  let hub = null;
  if (withHub) {
    hub = new EventHub({ client });
    await hub.start();
  }
  return { server, client, api, hub, close() { hub?.stop(); } };
}

export async function loadDiscovery(api) {
  const [providers, opencodeConfig, agents] = await Promise.all([api.providers(), api.getConfig(), api.agents()]);
  return { catalog: buildCatalog(providers), opencodeConfig, agents: agents ?? [] };
}

export function resolveModel(ctx, discovery, kind, modelInput, { variant = null } = {}) {
  const flags = modelInput ? { model: modelInput } : {};
  const { candidates, warnings } = resolveCandidates({ kind, flags, config: ctx.config, catalog: discovery.catalog, opencodeConfig: discovery.opencodeConfig });
  for (const warning of warnings ?? []) ctx.err(`[opc] ${warning}\n`);
  const candidate = candidates[0];
  const selection = validateSelection({ candidate, variant, catalog: discovery.catalog, policy: ctx.config.policy ?? {} });
  return { ...candidate, variant: selection.variant };
}

export function requireAgent(discovery, name, policy, { modes = null } = {}) {
  const agent = discovery.agents.find((a) => a.name === name);
  if (!agent) throw new UsageError('UNKNOWN_AGENT', `agente desconhecido: ${name.slice(0, 12)}${name.length > 12 ? '…' : ''} (veja /opc:agents)`);
  if (modes && !modes.includes(agent.mode)) {
    throw new UsageError('AGENT_MODE', `o agente ${name.slice(0, 12)}${name.length > 12 ? '…' : ''} tem modo "${agent.mode}"; aqui só ${modes.join(' ou ')} (para agentes primários use /opc:task --agent)`);
  }
  assertAgentUsable(agent, policy);
  return agent;
}

export function profileRules(ctx, profile, extra = []) {
  const policy = ctx.config.policy ?? {};
  const base = buildPermissionRules(profile, {
    policy,
    permissionProfiles: ctx.config.permissionProfiles ?? {},
    deniedAgentGlobs: policy.agents?.deny ?? [],
  });
  return [...base, ...extra];
}
