// Lifecycle of the per-workspace `opencode serve`: reuse, spawn, health, version, world checks, stop (spec §5).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { DEFAULT_CONFIG, matchesGlob } from './config.mjs';
import { createClient } from './http.mjs';
import { createApi } from './api.mjs';
import { loadOpencodeConfig, mergeOpencodeConfigSources } from './opencode-config.mjs';
import { withLock } from './locks.mjs';
import { ConnectionError, PolicyError, UsageError } from './opc-error.mjs';
import { getProcessIdentity, isPidAlive, spawnDetached, terminateProcessGroup } from './process.mjs';
import { registerSecret, redactText } from './redact.mjs';
import { EventHub } from './sse.mjs';
import { readJson, writeFileAtomic } from './state.mjs';

export const MIN_OPENCODE_VERSION = '2.0.22';
const MAX_BOOT_ATTEMPTS = 3;
const HEALTH_REUSE_TIMEOUT_MS = 2000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
export const LISTENING_RE = /\bserver listening on (https?:\/\/\S+)/;
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

export function resolveOpencodeBin({ env = process.env, config = {} } = {}) {
  return env.OPC_OPENCODE_BIN || config?.server?.opencodeBin || 'opencode';
}

export function serverMatcher(port, opencodeBin = 'opencode') {
  const wanted = String(port);
  return (cmdline) => {
    if (!Array.isArray(cmdline) || cmdline.length === 0) return false;
    const isOpencode = cmdline.slice(0, 3).some((arg) => /^opencode(\.exe)?$/.test(path.basename(arg)) || arg === opencodeBin);
    if (!isOpencode || !cmdline.includes('serve')) return false;
    return cmdline.some((arg, i) => (arg === '--port' && cmdline[i + 1] === wanted) || arg === `--port=${wanted}`);
  };
}

function serverFile(stateDir) {
  return path.join(stateDir, 'server.json');
}

function readServerRecordData(stateDir) {
  let record;
  try {
    record = readJson(serverFile(stateDir), null);
  } catch (err) {
    if (err.code === 'INVALID_JSON') return null;
    throw err;
  }
  if (!record || record.schemaVersion !== 1 || !Number.isInteger(record.pid) || !Number.isInteger(record.port)) return null;
  return record;
}

export function readServerRecord(stateDir) {
  const record = readServerRecordData(stateDir);
  if (!record || typeof record.password !== 'string' || record.password.length === 0) return null;
  if (record.password) registerSecret(record.password);
  return record;
}

function removeServerRecord(stateDir) {
  try {
    fs.unlinkSync(serverFile(stateDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  removeAttachSecret(stateDir);
}

function serverSettings(config) {
  return { ...DEFAULT_CONFIG.server, ...(config?.server ?? {}) };
}

function recordIdentityOk(record, opencodeBin = 'opencode') {
  const identity = getProcessIdentity(record.pid);
  if (!identity) return false;
  return String(identity.startTime) === String(record.startTime) && serverMatcher(record.port, opencodeBin)(identity.cmdline);
}

async function probeHealth(url, password, timeoutMs) {
  const client = createClient({ baseUrl: url, password, requestTimeoutMs: timeoutMs });
  try {
    const body = await createApi(client).info();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.version !== 'string') {
      return { ok: false, error: new ConnectionError('UNSUPPORTED_VERSION', 'A resposta de /api/info não contém uma versão válida do OpenCode V2.') };
    }
    return { ok: true, version: body.version };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function assertSupportedVersion(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health) || typeof health.version !== 'string' || !/^\d+\.\d+\.\d+/.test(health.version)) {
    throw new ConnectionError('UNSUPPORTED_VERSION', 'A resposta de /api/info não contém uma versão válida do OpenCode V2. Instale o OpenCode V2 ou configure server.opencodeBin (ou OPC_OPENCODE_BIN).');
  }
  if (compareVersions(health.version, MIN_OPENCODE_VERSION) < 0) {
    throw new ConnectionError('UNSUPPORTED_VERSION', `OpenCode ${health.version} é anterior ao mínimo suportado ${MIN_OPENCODE_VERSION}. Instale o OpenCode V2 ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.`);
  }
  return health.version;
}

async function shutdownRecorded(stateDir, record, opencodeBin = 'opencode') {
  const result = await terminateProcessGroup({ pid: record.pid, startTime: record.startTime }, serverMatcher(record.port, opencodeBin), {
    graceMs: 3000,
  });
  removeServerRecord(stateDir);
  return result;
}

// --- F3: attach secret (spec §10.5) ---------------------------------------------------
// Dedicated 0600 file holding only the server password, read inside the tmux pane.
export const ATTACH_SECRET_FILE = 'attach.secret';

export function attachSecretPath(stateDir) {
  return path.join(stateDir, ATTACH_SECRET_FILE);
}

export function writeAttachSecret(stateDir, password) {
  if (!password) return;
  writeFileAtomic(attachSecretPath(stateDir), password, { mode: 0o600 });
}

export function removeAttachSecret(stateDir) {
  try {
    fs.unlinkSync(attachSecretPath(stateDir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
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
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw new ConnectionError('BOOT_FAILED', `Não foi possível ler o log de inicialização do OpenCode (${err.code ?? err.message}).`, {
      cause: err,
    });
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
    const sources = await createApi(client).getConfigSources();
    if (!Array.isArray(sources)) {
      throw new Error('Resposta de GET /api/config não é uma lista de fontes.');
    }
    if (!sources.some((source) => source?.type === 'document' && source.info && typeof source.info === 'object' && !Array.isArray(source.info))) {
      throw new Error('Nenhuma fonte de configuração do OpenCode V2 foi encontrada.');
    }
    oc = mergeOpencodeConfigSources(sources);
  } catch (err) {
    world.shareBlocked = true;
    world.shareReason = 'config-unavailable';
    warnings.push(`Não foi possível ler GET /api/config para as checagens de mundo: ${err.code ?? err.message}`);
    return { world, warnings };
  }
  if (oc?.share === 'auto' || (oc?.autoshare === true && oc?.share !== 'disabled')) {
    world.shareBlocked = true;
    world.shareReason = 'share-auto';
    warnings.push('O OpenCode está com share "auto": o opc recusa criar sessões até o share ser desligado '
      + '(server.configOverride.share = "disabled" na config global do opc, ou share "manual"/"disabled" no OpenCode).');
  }
  for (const key of ['model', 'small_model']) {
    if (isDeniedModel(oc?.[key], config?.policy)) {
      world.deniedDefaults.push(key);
      warnings.push(`O "${key}" do OpenCode (${String(oc[key]).slice(0, 12)}…) é negado pela política do opc; `
        + `considere trocar via server.configOverride.${key}.`);
    }
  }
  return { world, warnings };
}

export function assertCanCreateSessions(server) {
  if (server?.world?.shareBlocked) {
    if (server.world.shareReason === 'config-unavailable') {
      throw new PolicyError('SHARE_AUTO', 'Criação de sessões bloqueada: não foi possível confirmar a configuração de compartilhamento. Tente novamente e verifique o servidor OpenCode.');
    }
    throw new PolicyError('SHARE_AUTO', 'Criação de sessões recusada: o OpenCode está com share "auto". Rode /opc:setup para ver como desligar.');
  }
}

// V2 loads providers while the instance bootstraps: until the first `model.updated` event, /api/model may list
// only built-in providers (gateway providers arrived ~11 s after boot on the operator's machine). Resolves true on
// that event and false when the event stream fails, so the caller never waits on a broken stream.
export function watchCatalogBootstrap(client, { fetchImpl } = {}) {
  const hub = new EventHub({ client, ...(fetchImpl ? { fetchImpl } : {}) });
  let settle;
  const ready = new Promise((resolve) => { settle = resolve; });
  hub.onAny((event) => { if (event?.type === 'model.updated') settle(true); });
  hub.onDown(() => settle(false));
  const opened = hub.start().then(() => true, () => { settle(false); return false; });
  return { ready, opened, stop: () => { settle(false); hub.stop(); } };
}

export function expectedProviders(opencodeConfig) {
  // V2 reports the declared providers under `providers` (live fixtures opencode-2.0.22/config.json and
  // config-precedence.json); the singular V1 `provider` is kept as a fallback.
  const declared = Object.keys(opencodeConfig?.providers ?? opencodeConfig?.provider ?? {});
  const enabled = Array.isArray(opencodeConfig?.enabled_providers) ? new Set(opencodeConfig.enabled_providers) : null;
  const disabled = new Set(Array.isArray(opencodeConfig?.disabled_providers) ? opencodeConfig.disabled_providers : []);
  return declared.filter((id) => !disabled.has(id) && (!enabled || enabled.has(id)));
}

// Ready when every declared provider is listed (the bootstrap event only shortens the wait). A provider that
// never loads (bad key, gateway down) ends the wait at the deadline and is reported in `missing`. `settleMs`
// bounds how long to keep waiting for missing providers once the catalog is non-empty (default: until the
// deadline); the deadline itself keeps applying while the catalog is empty.
export async function waitForModelCatalog(api, { timeoutMs = 20_000, pollMs = 200, bootstrap = null, bootstrapTimeoutMs = 30_000, expected = [], settleMs = Infinity } = {}) {
  let announced = false;
  let bootstrapSettled = false;
  bootstrap?.then((value) => { announced = value === true; bootstrapSettled = true; });
  const startedAt = performance.now();
  const bootstrapDeadline = startedAt + bootstrapTimeoutMs;
  const capMs = Math.max(timeoutMs, bootstrap ? bootstrapTimeoutMs : 0);
  const deadline = startedAt + capMs;
  const timeoutError = () => new ConnectionError('TIMEOUT', `O catálogo de modelos do OpenCode não carregou em ${Math.round(capMs / 1000)} s. Aguarde o servidor terminar de subir ou confira os providers da config do OpenCode.`);
  const missingFrom = (list) => expected.filter((id) => !list.some((m) => m.providerID === id));
  let models = [];
  let lastListed = [];
  let firstListedAt = null;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (lastListed.length === 0) throw timeoutError();
      return { models: lastListed, missing: missingFrom(lastListed) };
    }
    try {
      models = await api.models({ timeoutMs: Math.max(1, Math.ceil(remaining)) });
    } catch (err) {
      if (err.code === 'TIMEOUT' && performance.now() >= deadline) {
        if (lastListed.length === 0) throw timeoutError();
        return { models: lastListed, missing: missingFrom(lastListed) };
      }
      throw err;
    }
    if (!Array.isArray(models)) throw new ConnectionError('UNSUPPORTED_VERSION', 'O catálogo de modelos não tem o formato do OpenCode V2.');
    if (models.length > 0) {
      lastListed = models;
      firstListedAt ??= performance.now();
    }
    const missing = missingFrom(models);
    // With declared providers, their presence is the signal. Without any, keep the F6 rule: wait for
    // model.updated until the bootstrap deadline (gateway providers can come from outside `provider`). A
    // bootstrap that settled without the event (stream down or failed) is over: nothing more to wait for.
    const bootstrapOver = !bootstrap || bootstrapSettled || performance.now() >= bootstrapDeadline;
    const ready = announced || (missing.length === 0 && (expected.length > 0 || bootstrapOver));
    if (models.length > 0 && ready) return { models, missing };
    if (models.length > 0 && performance.now() - firstListedAt >= settleMs) return { models, missing };
    const delay = Math.min(pollMs, deadline - performance.now());
    if (delay > 0) await sleep(delay);
  }
}

const missingProvidersWarning = (missing) => `Providers declarados ainda sem modelos no catálogo: ${missing.join(', ')}. Confira credenciais e o gateway.`;

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
  const api = createApi(client);
  const health = await api.info();
  assertSupportedVersion(health);
  const { missing } = await waitForModelCatalog(api, { timeoutMs: 15_000, settleMs: 2_000, expected: expectedProviders(await loadOpencodeConfig(api)) });
  const { world, warnings } = await worldCheck(client, config);
  warnings.unshift('Modo attach: o opc não sobe nem encerra este servidor, e o server.configOverride não se aplica.');
  if (missing.length) warnings.push(missingProvidersWarning(missing));
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
    OPENCODE_CONFIG_CONTENT: JSON.stringify(settings.configOverride ?? {}),
    OPC_INSIDE_SERVER: '1',
  };
  delete childEnv.OPC_SERVER_URL;
  delete childEnv.OPC_SERVER_PASSWORD;
  delete childEnv.OPENCODE_SERVER_USERNAME;
  let proc;
  try {
    proc = await spawnDetached(opencodeBin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: workspaceRoot,
      env: childEnv,
      logFile,
    });
  } catch (err) {
    throw new ConnectionError('BOOT_FAILED', 'Não foi possível executar o binário OpenCode. Instale o OpenCode V2 ou configure server.opencodeBin (ou OPC_OPENCODE_BIN).', {
      cause: err,
    });
  }
  const startTime = proc.startTime ?? getProcessIdentity(proc.pid)?.startTime ?? null;
  const url = `http://127.0.0.1:${port}`;
  let outcome;
  try {
    outcome = await waitForListening({
      logFile, offset, port, url, password, pid: proc.pid, timeoutMs: settings.bootTimeoutSec * 1000,
    });
  } catch (err) {
    await terminateProcessGroup({ pid: proc.pid, startTime }, serverMatcher(port, opencodeBin), { graceMs: 3000 });
    throw err;
  }
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
    const matcher = serverMatcher(res.port, opencodeBin);
    if (!res.ok) {
      failures.push(`tentativa ${attempt} (porta ${res.port}): ${res.reason} — ${res.detail}`);
      await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
      continue;
    }
    const client = createClient({ baseUrl: res.url, password, directory: workspaceRoot, requestTimeoutMs: settings.requestTimeoutSec * 1000 });
    // Subscribe before the first workspace request so the bootstrap's `model.updated` is not missed; a stream
    // that does not open in 5 s only costs the event (the catalog wait falls back to the non-empty check).
    const bootstrap = watchCatalogBootstrap(client);
    let health;
    let identity;
    const catalogWarnings = [];
    try {
      let openTimer;
      await Promise.race([bootstrap.opened, new Promise((resolve) => { openTimer = setTimeout(resolve, 5000); })]);
      clearTimeout(openTimer);
      try {
        health = await createApi(client).info();
      } catch (err) {
        await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
        if (err.code === 'AUTH_FAILED' || err.code === 'NOT_JSON') throw err;
        failures.push(`tentativa ${attempt} (porta ${res.port}): health falhou — ${err.code}`);
        continue;
      }
      try { assertSupportedVersion(health); }
      catch (err) { await terminateProcessGroup(expected, matcher, { graceMs: 3000 }); throw err; }
      identity = getProcessIdentity(res.pid);
      if (!identity || !matcher(identity.cmdline)) {
        throw new ConnectionError('BOOT_FAILED', `O processo ${res.pid} não se identifica como "opencode serve --port ${res.port}"; o opc não vai registrá-lo nem sinalizá-lo.`);
      }
      try {
        const api = createApi(client);
        if (!Array.isArray(await api.agents())) throw new ConnectionError('UNSUPPORTED_VERSION', 'O catálogo de agentes não tem o formato do OpenCode V2.');
        const opencodeConfig = await loadOpencodeConfig(api);
        const { missing } = await waitForModelCatalog(api, { bootstrap: bootstrap.ready, expected: expectedProviders(opencodeConfig) });
        if (missing.length) catalogWarnings.push(missingProvidersWarning(missing));
      } catch (err) {
        await terminateProcessGroup(expected, matcher, { graceMs: 3000 });
        throw err;
      }
    } finally {
      bootstrap.stop();
    }
    const warnings = [];
    warnings.push(...catalogWarnings);
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
    let recorded = false;
    try {
      writeFileAtomic(serverFile(stateDir), record, { mode: 0o600 });
      recorded = true;
      writeAttachSecret(stateDir, password);
    } catch (err) {
      try { removeAttachSecret(stateDir); }
      finally { await terminateProcessGroup(expected, matcher, { graceMs: 3000 }); }
      if (recorded) removeServerRecord(stateDir);
      throw err;
    }
    return { url: res.url, password, version: health.version, pid: res.pid, port: res.port, attached: false, reused: false, world: checked.world, warnings };
  }
  throw new ConnectionError('BOOT_FAILED', `opencode serve não subiu após ${MAX_BOOT_ATTEMPTS} tentativas: ${failures.join('; ')}`, {
    details: { failures },
  });
}

export async function ensureServer(ctx) {
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  const full = { ...ctx, opencodeBin: ctx.opencodeBin ?? resolveOpencodeBin({ env, config }), env, hasActiveJobs };
  const settings = serverSettings(config);
  const lockTimeout = 4 * settings.bootTimeoutSec * 1000;
  return withLock(path.join(stateDir, 'server.lock'), { timeoutMs: lockTimeout, purpose: 'ensure-server' }, async () => {
    if (env.OPC_SERVER_URL) return attachServer(env, settings, config);
    let record = readServerRecord(stateDir);
    const warnings = [];
    if (!record) {
      const unusable = readServerRecordData(stateDir);
      if (unusable && (typeof unusable.password !== 'string' || unusable.password.length === 0)) {
        if (!recordIdentityOk(unusable, full.opencodeBin)) {
          removeServerRecord(stateDir);
          warnings.push(`Registro de servidor antigo descartado (pid ${unusable.pid} não é mais o servidor do opc); nenhum sinal enviado.`);
        } else {
          await shutdownRecorded(stateDir, unusable, full.opencodeBin);
          warnings.push(`Servidor anterior encerrado: registro do servidor sem senha utilizável (pid ${unusable.pid}).`);
        }
      }
    }
    if (record) {
      if (!recordIdentityOk(record, full.opencodeBin)) {
        removeServerRecord(stateDir);
        warnings.push(`Registro de servidor antigo descartado (pid ${record.pid} não é mais o servidor do opc); nenhum sinal enviado.`);
      } else {
        const health = await probeHealth(record.url, record.password, HEALTH_REUSE_TIMEOUT_MS);
        if (health.error?.code === 'AUTH_FAILED') throw health.error;
        // The identity check above proved this is opc's own process: an old (V1) server answers /api/info with
        // the SPA (NOT_JSON) or an old version, so replace it instead of failing every command.
        const incompatible = health.error?.code === 'NOT_JSON' || health.error?.code === 'UNSUPPORTED_VERSION'
          || (health.ok && compareVersions(health.version, MIN_OPENCODE_VERSION) < 0);
        if (incompatible) {
          if (hasActiveJobs()) {
            throw new UsageError('V1_SERVER_ACTIVE', 'O servidor gerenciado registrado é anterior ao OpenCode 2.0.22 e há jobs ativos nele; aguarde (/opc:status) ou cancele (/opc:cancel) e rode o comando de novo.');
          }
          await shutdownRecorded(stateDir, record, full.opencodeBin);
          warnings.push('Servidor gerenciado anterior ao OpenCode 2.0.22 encerrado; um servidor V2 será iniciado.');
        } else {
          if (health.ok && health.version === record.version) {
            const checked = await worldCheck(createClient({ baseUrl: record.url, password: record.password, requestTimeoutMs: settings.requestTimeoutSec * 1000 }), config);
            record.world = checked.world;
            writeFileAtomic(serverFile(stateDir), record, { mode: 0o600 });
            return {
              url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
              attached: false, reused: true, world: checked.world, warnings: [...warnings, ...checked.warnings],
            };
          }
          if (health.ok && hasActiveJobs()) {
            warnings.push(`O OpenCode mudou de versão (${record.version} → ${health.version}), mas há jobs ativos: servidor reaproveitado.`);
            const checked = await worldCheck(createClient({ baseUrl: record.url, password: record.password, requestTimeoutMs: settings.requestTimeoutSec * 1000 }), config);
            record.world = checked.world;
            writeFileAtomic(serverFile(stateDir), record, { mode: 0o600 });
            return {
              url: record.url, password: record.password, version: record.version, pid: record.pid, port: record.port,
              attached: false, reused: true, world: checked.world, warnings: [...warnings, ...checked.warnings],
            };
          }
          const why = health.ok ? `versão mudou (${record.version} → ${health.version})` : 'servidor travado (health sem resposta)';
          await shutdownRecorded(stateDir, record, full.opencodeBin);
          warnings.push(`Servidor anterior encerrado: ${why}.`);
        }
      }
    }
    const booted = await bootServer(full, settings);
    return { ...booted, warnings: [...warnings, ...booted.warnings] };
  });
}

async function stopServerUnlocked(ctx, { force = false, confirmedByUser = false } = {}) {
  if (force && !confirmedByUser) {
    throw new UsageError('CONFIRMATION_REQUIRED', '--force exige --confirmed-by-user (confirmação explícita do usuário).');
  }
  const { stateDir, config, env = process.env, hasActiveJobs = () => false } = ctx;
  if (env.OPC_SERVER_URL) return { stopped: false, reason: 'attached' };
  const record = readServerRecordData(stateDir);
  if (record?.password) registerSecret(record.password);
  if (!record) {
    removeAttachSecret(stateDir);
    return { stopped: false, reason: 'not-running' };
  }
  if (hasActiveJobs() && !force) return { stopped: false, reason: 'active-jobs' };
  const identity = getProcessIdentity(record.pid);
  if (!identity) {
    removeServerRecord(stateDir);
    return { stopped: false, reason: 'not-running' };
  }
  const opencodeBin = ctx.opencodeBin ?? resolveOpencodeBin({ env, config });
  if (!recordIdentityOk(record, opencodeBin)) {
    removeServerRecord(stateDir);
    return { stopped: false, reason: 'identity-mismatch' };
  }
  const result = await shutdownRecorded(stateDir, record, opencodeBin);
  if (result === 'identity-mismatch') return { stopped: false, reason: 'identity-mismatch' };
  return { stopped: true, reason: result === 'killed' ? 'killed' : 'terminated' };
}

export async function stopServer(ctx, { force = false, confirmedByUser = false, lockHeld = false } = {}) {
  const run = () => stopServerUnlocked(ctx, { force, confirmedByUser });
  if (lockHeld) return run();
  return withLock(
    path.join(ctx.stateDir, 'server.lock'),
    { timeoutMs: 4 * serverSettings(ctx.config).bootTimeoutSec * 1000, purpose: 'stop-server' },
    run,
  );
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
