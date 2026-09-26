// Lifecycle of the per-workspace `opencode serve`: reuse, spawn, health, version, world checks, stop (spec §5).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { DEFAULT_CONFIG, matchesGlob } from './config.mjs';
import { createClient } from './http.mjs';
import { withLock } from './locks.mjs';
import { ConnectionError, PolicyError, UsageError } from './opc-error.mjs';
import { getProcessIdentity, isPidAlive, spawnDetached, terminateProcessGroup } from './process.mjs';
import { registerSecret, redactText } from './redact.mjs';
import { readJson, writeFileAtomic } from './state.mjs';

export const MIN_OPENCODE_VERSION = '1.18.0';
const MAX_BOOT_ATTEMPTS = 3;
const HEALTH_REUSE_TIMEOUT_MS = 2000;
const DISPOSE_TIMEOUT_MS = 3000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LISTENING_RE = /opencode server listening on (https?:\/\/[^\s]+)/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function serverMatcher(port) {
  const wanted = String(port);
  return (cmdline) => {
    if (!Array.isArray(cmdline) || cmdline.length === 0) return false;
    const isOpencode = cmdline.slice(0, 3).some((arg) => /^opencode(\.exe)?$/.test(path.basename(arg)));
    if (!isOpencode || !cmdline.includes('serve')) return false;
    return cmdline.some((arg, i) => (arg === '--port' && cmdline[i + 1] === wanted) || arg === `--port=${wanted}`);
  };
}

function serverFile(stateDir) {
  return path.join(stateDir, 'server.json');
}

export function readServerRecord(stateDir) {
  let record;
  try {
    record = readJson(serverFile(stateDir), null);
  } catch (err) {
    if (err.code === 'INVALID_JSON') return null;
    throw err;
  }
  if (!record || record.schemaVersion !== 1 || !Number.isInteger(record.pid) || !Number.isInteger(record.port)) return null;
  if (record.password) registerSecret(record.password);
  return record;
}

function removeServerRecord(stateDir) {
  try {
    fs.unlinkSync(serverFile(stateDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function serverSettings(config) {
  return { ...DEFAULT_CONFIG.server, ...(config?.server ?? {}) };
}

function recordIdentityOk(record) {
  const identity = getProcessIdentity(record.pid);
  if (!identity) return false;
  return String(identity.startTime) === String(record.startTime) && serverMatcher(record.port)(identity.cmdline);
}

async function probeHealth(url, password, timeoutMs) {
  const client = createClient({ baseUrl: url, password, requestTimeoutMs: timeoutMs });
  try {
    const body = await client.get('/global/health', { retryOnServerDown: false });
    return { ok: body?.healthy === true, version: body?.version ?? null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function shutdownRecorded(stateDir, record) {
  const client = createClient({ baseUrl: record.url, password: record.password, requestTimeoutMs: DISPOSE_TIMEOUT_MS });
  try {
    await client.post('/global/dispose', undefined, { retryOnServerDown: false });
  } catch {
    // dispose is best effort; the signals below decide
  }
  const result = await terminateProcessGroup({ pid: record.pid, startTime: record.startTime }, serverMatcher(record.port), {
    graceMs: 3000,
  });
  removeServerRecord(stateDir);
  return result;
}

function truncateLogIfLarge(logFile) {
  try {
    if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.truncateSync(logFile, 0);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readFrom(file, offset) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return '';
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function waitForListening({ logFile, offset, port, url, password, pid, timeoutMs }) {
  const deadline = performance.now() + timeoutMs;
  let iteration = 0;
  while (performance.now() < deadline) {
    const text = readFrom(logFile, offset);
    const m = LISTENING_RE.exec(text);
    if (m) {
      const announced = Number(new URL(m[1]).port);
      if (announced === port) return { ok: true };
      return { ok: false, reason: 'port-mismatch', detail: `anunciou a porta ${announced}, pedida ${port}` };
    }
    if (!isPidAlive(pid)) {
      const tail = redactText(text.trim().split('\n').slice(-3).join(' | '));
      return { ok: false, reason: 'exited', detail: tail || 'processo terminou sem saída' };
    }
    if (iteration % 5 === 4) {
      const health = await probeHealth(url, password, 500);
      if (health.ok || health.error?.code === 'AUTH_FAILED') return { ok: true };
    }
    iteration += 1;
    await sleep(100);
  }
  return { ok: false, reason: 'timeout', detail: `sem a linha "listening on" em ${Math.round(timeoutMs / 1000)} s` };
}

function isDeniedModel(full, policy) {
  if (!full || typeof full !== 'string') return false;
  const provider = full.split('/')[0];
  const p = policy ?? DEFAULT_CONFIG.policy;
  const listDenied = (value, lists) => {
    if ((lists?.deny ?? []).some((g) => matchesGlob(value, g))) return true;
    const allow = lists?.allow ?? [];
    return allow.length > 0 && !allow.some((g) => matchesGlob(value, g));
  };
  return listDenied(provider, p.providers) || listDenied(full, p.models);
}

async function worldCheck(client, config) {
  const world = { shareBlocked: false, deniedDefaults: [] };
  const warnings = [];
  let oc;
  try {
    oc = await client.get('/config', { retryOnServerDown: false });
  } catch (err) {
    warnings.push(`Não foi possível ler GET /config para as checagens de mundo: ${err.code ?? err.message}`);
    return { world, warnings };
  }
  if (oc?.share === 'auto' || (oc?.autoshare === true && oc?.share !== 'disabled')) {
    world.shareBlocked = true;
    warnings.push('O OpenCode está com share "auto": o opc recusa criar sessões até o share ser desligado '
      + '(server.configOverride.share = "disabled" na config global do opc, ou share "manual"/"disabled" no OpenCode).');
  }
  for (const key of ['model', 'small_model']) {
    if (isDeniedModel(oc?.[key], config?.policy)) {
      world.deniedDefaults.push(key);
      warnings.push(`O "${key}" do OpenCode (${oc[key]}) é negado pela política do opc; `
        + `considere trocar via server.configOverride.${key}.`);
    }
  }
  return { world, warnings };
}

export function assertCanCreateSessions(server) {
  if (server?.world?.shareBlocked) {
    throw new PolicyError('SHARE_AUTO', 'Criação de sessões recusada: o OpenCode está com share "auto". Rode /opc:setup para ver como desligar.');
  }
}

async function attachServer(env, settings, config) {
  let parsed;
  try {
    parsed = new URL(env.OPC_SERVER_URL);
  } catch {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL inválida.');
  }
  if (parsed.username || parsed.password) {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL não pode conter credenciais; use OPC_SERVER_PASSWORD.');
  }
  const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!secure) {
    throw new UsageError('INSECURE_SERVER_URL', 'OPC_SERVER_URL precisa ser http://127.0.0.1, http://localhost ou https://.');
  }
  const url = parsed.origin;
  const password = env.OPC_SERVER_PASSWORD || null;
  registerSecret(password);
  const client = createClient({ baseUrl: url, password, requestTimeoutMs: settings.requestTimeoutSec * 1000 });
  const health = await client.get('/global/health', { retryOnServerDown: false });
  if (compareVersions(health?.version, MIN_OPENCODE_VERSION) < 0) {
    throw new ConnectionError('UNSUPPORTED_VERSION', `OpenCode ${health?.version} é anterior ao mínimo ${MIN_OPENCODE_VERSION}.`);
  }
  const { world, warnings } = await worldCheck(client, config);
  warnings.unshift('Modo attach: o opc não sobe nem encerra este servidor, e o server.configOverride não se aplica.');
  return { url, password, version: health.version, pid: null, port: Number(parsed.port) || null, attached: true, reused: true, world, warnings };
}

async function spawnOnce({ stateDir, workspaceRoot, env, opencodeBin, settings, password }) {
  const port = await pickFreePort();
  const logFile = path.join(stateDir, 'server.log');
  truncateLogIfLarge(logFile);
  const offset = fileSize(logFile);
  const childEnv = {
    ...env,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(settings.configOverride ?? {}),
    OPC_INSIDE_SERVER: '1',
  };
  delete childEnv.OPC_SERVER_URL;
  delete childEnv.OPC_SERVER_PASSWORD;
  let proc;
  try {
    proc = await spawnDetached(opencodeBin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: workspaceRoot,
      env: childEnv,
      logFile,
    });
  } catch (err) {
    throw new ConnectionError('BOOT_FAILED', `Não foi possível executar "${opencodeBin}": instale o OpenCode (npm install -g opencode-ai).`, {
      cause: err,
    });
  }
  const startTime = proc.startTime ?? getProcessIdentity(proc.pid)?.startTime ?? null;
  const url = `http://127.0.0.1:${port}`;
  const outcome = await waitForListening({
    logFile, offset, port, url, password, pid: proc.pid, timeoutMs: settings.bootTimeoutSec * 1000,
  });
  return { ...outcome, port, url, pid: proc.pid, startTime };
}

async function bootServer(ctx, settings) {
  const { stateDir, workspaceRoot, env, opencodeBin, config } = ctx;
  const password = randomBytes(24).toString('hex');
  registerSecret(password);
  const failures = [];
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt += 1) {
    const res = await spawnOnce({ stateDir, workspaceRoot, env, opencodeBin, settings, password });
    const expected = { pid: res.pid, startTime: res.startTime };
    const matcher = serverMatcher(res.port);
    if (!res.ok) {
      failures.push(`tentativa ${attempt} (porta ${res.port}): ${res.reason} — ${res.detail}`);
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      continue;
    }
    const client = createClient({ baseUrl: res.url, password, directory: workspaceRoot, requestTimeoutMs: settings.requestTimeoutSec * 1000 });
    let health;
    try {
      health = await client.get('/global/health', { retryOnServerDown: false });
    } catch (err) {
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      if (err.code === 'AUTH_FAILED') throw err;
      failures.push(`tentativa ${attempt} (porta ${res.port}): health falhou — ${err.code}`);
      continue;
    }
    if (compareVersions(health?.version, MIN_OPENCODE_VERSION) < 0) {
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      throw new ConnectionError('UNSUPPORTED_VERSION', `OpenCode ${health?.version} é anterior ao mínimo suportado ${MIN_OPENCODE_VERSION}. Atualize com npm install -g opencode-ai.`);
    }
    const identity = getProcessIdentity(res.pid);
    if (!identity || !matcher(identity.cmdline)) {
      throw new ConnectionError('BOOT_FAILED', `O processo ${res.pid} não se identifica como "opencode serve --port ${res.port}"; o opc não vai registrá-lo nem sinalizá-lo.`);
    }
    const warnings = [];
    try {
      await client.get('/agent', { timeoutMs: settings.bootTimeoutSec * 1000, retryOnServerDown: false });
    } catch (err) {
      warnings.push(`Aquecimento (GET /agent) falhou: ${err.code ?? err.message}`);
    }
    const checked = await worldCheck(client, config);
    warnings.push(...checked.warnings);
    const record = {
      schemaVersion: 1,
      pid: res.pid,
      startTime: identity.startTime,
      port: res.port,
      url: res.url,
      version: health.version,
      password,
      startedAt: new Date().toISOString(),
      spawnedBy: 'opc',
      cmdline: identity.cmdline,
      world: checked.world,
    };
    writeFileAtomic(serverFile(stateDir), record, { mode: 0o600 });
    return { url: res.url, password, version: health.version, pid: res.pid, port: res.port, attached: false, reused: false, world: checked.world, warnings };
  }
  throw new ConnectionError('BOOT_FAILED', `opencode serve não subiu após ${MAX_BOOT_ATTEMPTS} tentativas: ${failures.join('; ')}`, {
    details: { failures },
  });
}

export async function ensureServer(ctx) {
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  const full = { opencodeBin: 'opencode', ...ctx, env, hasActiveJobs };
  const settings = serverSettings(config);
  const lockTimeout = 4 * settings.bootTimeoutSec * 1000;
  return withLock(path.join(stateDir, 'server.lock'), { timeoutMs: lockTimeout, purpose: 'ensure-server' }, async () => {
    if (env.OPC_SERVER_URL) return attachServer(env, settings, config);
    const record = readServerRecord(stateDir);
    const warnings = [];
    if (record) {
      if (!recordIdentityOk(record)) {
        removeServerRecord(stateDir);
        warnings.push(`Registro de servidor antigo descartado (pid ${record.pid} não é mais o servidor do opc); nenhum sinal enviado.`);
      } else {
        const health = await probeHealth(record.url, record.password, HEALTH_REUSE_TIMEOUT_MS);
        if (health.error?.code === 'AUTH_FAILED') throw health.error;
        if (health.ok && health.version === record.version) {
          return {
            url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
            attached: false, reused: true, world: record.world ?? { shareBlocked: false, deniedDefaults: [] }, warnings,
          };
        }
        if (health.ok && hasActiveJobs()) {
          warnings.push(`O OpenCode mudou de versão (${record.version} → ${health.version}), mas há jobs ativos: servidor reaproveitado.`);
          return {
            url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
            attached: false, reused: true, world: record.world ?? { shareBlocked: false, deniedDefaults: [] }, warnings,
          };
        }
        const why = health.ok ? `versão mudou (${record.version} → ${health.version})` : 'servidor travado (health sem resposta)';
        await shutdownRecorded(stateDir, record);
        warnings.push(`Servidor anterior encerrado: ${why}.`);
      }
    }
    const booted = await bootServer(full, settings);
    return { ...booted, warnings: [...warnings, ...booted.warnings] };
  });
}

export async function stopServer(ctx, { force = false, confirmedByUser = false } = {}) {
  if (force && !confirmedByUser) {
    throw new UsageError('CONFIRMATION_REQUIRED', '--force exige --confirmed-by-user (confirmação explícita do usuário).');
  }
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  const settings = serverSettings(config);
  return withLock(path.join(stateDir, 'server.lock'), { timeoutMs: 4 * settings.bootTimeoutSec * 1000, purpose: 'stop-server' }, async () => {
    if (env.OPC_SERVER_URL) return { stopped: false, reason: 'attached' };
    const record = readServerRecord(stateDir);
    if (!record) return { stopped: false, reason: 'not-running' };
    if (hasActiveJobs() && !force) return { stopped: false, reason: 'active-jobs' };
    const identity = getProcessIdentity(record.pid);
    if (!identity) {
      removeServerRecord(stateDir);
      return { stopped: false, reason: 'not-running' };
    }
    if (!recordIdentityOk(record)) {
      removeServerRecord(stateDir);
      return { stopped: false, reason: 'identity-mismatch' };
    }
    const result = await shutdownRecorded(stateDir, record);
    if (result === 'identity-mismatch') return { stopped: false, reason: 'identity-mismatch' };
    return { stopped: true, reason: result === 'killed' ? 'killed' : 'terminated' };
  });
}

export function clientFor(ctx, server) {
  const settings = serverSettings(ctx.config);
  return createClient({
    baseUrl: server.url,
    password: server.password,
    directory: ctx.workspaceRoot,
    requestTimeoutMs: settings.requestTimeoutSec * 1000,
    onServerDown: () => ensureServer(ctx).then((s) => ({ url: s.url, password: s.password })),
  });
}
