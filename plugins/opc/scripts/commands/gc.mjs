// opc gc: removes workspace states unused for more than N days, only on explicit command (spec §3.2).
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ConnectionError, ExitCode, UsageError } from '../lib/opc-error.mjs';
import { identityMatches } from '../lib/process.mjs';
import { readServerRecord, serverMatcher } from '../lib/server.mjs';
import { createPrompter } from '../lib/tty.mjs';
import { isActive, listJobs } from '../lib/jobs.mjs';
import { renderTable } from '../lib/render.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';

const STATE_DIR_RE = /^.+-[0-9a-f]{16}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function newestMtime(dir) {
  let newest = 0;
  const visit = (path) => {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.endsWith('.lock') || entry.name.endsWith('.break') || entry.name.includes('.lock.')) continue;
      const full = join(path, entry.name);
      const info = lstatSync(full);
      if (info.isFile()) newest = Math.max(newest, info.mtimeMs);
      else if (info.isDirectory()) visit(full);
    }
  };
  visit(dir);
  return newest;
}

function staleResults(candidates = []) {
  Object.defineProperty(candidates, 'skipped', { value: [], enumerable: false });
  return candidates;
}

function serverStatus(dir, deps) {
  let raw;
  try {
    raw = readFileSync(join(dir, 'server.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { live: false };
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { live: false, reason: 'server.json contém JSON inválido; candidato preservado.' };
  }
  const record = deps.readServerRecord(dir);
  const fallback = record ?? data;
  if (!Number.isInteger(fallback?.pid) || fallback.startTime == null) return { live: false };
  if (!Number.isInteger(fallback.port)) {
    return { live: false, reason: 'server.json não contém uma identidade completa; candidato preservado.' };
  }
  const matches = deps.identityMatches(
    { pid: fallback.pid, startTime: fallback.startTime },
    serverMatcher(fallback.port),
  );
  return { live: matches };
}

const defaultDeps = { identityMatches, readServerRecord, tryAcquireLock, confirm: null };

function skip(stale, dir, name, reason) {
  stale.skipped.push({ dir, name, reason });
}

export function findStaleStates(dataDir, { olderThanMs, exclude = null, now = Date.now() } = {}, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const root = join(dataDir, 'state');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return staleResults();
    throw new ConnectionError('GC_READ_FAILED', `Não foi possível ler o diretório de estados do opc (${err.code ?? 'erro de leitura'}).`, { cause: err });
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const stale = staleResults();
  for (const entry of entries) {
    if (!entry.isDirectory() || !STATE_DIR_RE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    if (exclude && resolve(dir) === resolve(exclude)) continue;
    try {
      const identity = lstatSync(dir);
      if (!identity.isDirectory() || identity.isSymbolicLink() || (uid !== null && identity.uid !== uid)) continue;
      const lastUsed = newestMtime(dir);
      if (now - lastUsed <= olderThanMs) continue;
      if (listJobs(dir, { all: true }).some(isActive)) continue;
      const server = serverStatus(dir, deps);
      if (server.reason) {
        skip(stale, dir, entry.name, server.reason);
        continue;
      }
      if (server.live) continue;
      stale.push({ dir, name: entry.name, lastUsed: new Date(lastUsed).toISOString(), dev: identity.dev, ino: identity.ino });
    } catch (err) {
      skip(stale, dir, entry.name, `Não foi possível verificar o estado; candidato preservado (${err.code ?? 'erro de leitura'}).`);
    }
  }
  return stale.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
}

export async function run(ctx, argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { flags } = parseArgs(argv, {
    flags: { json: { type: 'boolean' }, cwd: { type: 'string' }, days: { type: 'number', default: 30 }, 'confirmed-by-user': { type: 'boolean' } },
  });
  if (!Number.isInteger(flags.days) || flags.days < 1) throw new UsageError('USAGE', '--days deve ser um inteiro maior ou igual a 1.');
  const days = flags.days;
  const stale = findStaleStates(ctx.dataDir, { olderThanMs: days * DAY_MS, exclude: ctx.stateDir }, deps);
  if (stale.length === 0) {
    if (flags.json) ctx.json({ removed: [], candidates: [], skipped: stale.skipped });
    else if (stale.skipped.length) ctx.out(`# opc gc\n\nNenhum candidato removido. Estados preservados:\n${stale.skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}\n`);
    else ctx.out(`opc gc: nada a remover; nenhum estado de workspace sem uso há mais de ${days} dias.\n`);
    return ExitCode.OK;
  }
  const table = renderTable(['Estado', 'Último uso'], stale.map((s) => [s.name, s.lastUsed]));
  let confirmed = Boolean(flags['confirmed-by-user']);
  if (!confirmed) {
    if (!ctx.stdin?.isTTY) {
      if (flags.json) ctx.json({ removed: [], candidates: stale.map(publicCandidate), skipped: stale.skipped, needsConfirmation: true });
      else ctx.out(`# opc gc\n\nEstes estados seriam removidos:\n\n${table}\n${stale.skipped.length ? `\nPreservados:\n${stale.skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}\n` : ''}\nNada foi removido. Execute em um terminal ou use --confirmed-by-user após obter confirmação do usuário.\n`);
      return ExitCode.USAGE;
    }
    ctx.err(`# opc gc\n\n${table}\n\n`);
    if (deps.confirm) confirmed = await deps.confirm(`Remover estes ${stale.length} diretórios de estado?`);
    else {
      const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
      try {
        confirmed = await prompter.confirm(`Remover estes ${stale.length} diretórios de estado?`);
      } finally {
        prompter.close();
      }
    }
    if (!confirmed) {
      ctx.out('opc gc: nada foi removido.\n');
      return ExitCode.OK;
    }
  }
  const removed = [];
  const removedStates = [];
  const skipped = [...stale.skipped];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const s of stale) {
    const held = [];
    let lockFailed = false;
    try {
      for (const lockName of ['state.lock', 'server.lock']) {
        let release;
        try {
          release = deps.tryAcquireLock(join(s.dir, lockName), { purpose: 'gc' });
        } catch {
          skipped.push({ dir: s.dir, name: s.name, reason: 'Estado em uso; não foi possível adquirir o lock.' });
          lockFailed = true;
          break;
        }
        if (!release) break;
        held.push(release);
      }
      if (held.length !== 2) {
        if (!lockFailed) skipped.push({ dir: s.dir, name: s.name, reason: 'Estado em uso; lock ocupado.' });
        continue;
      }
      const current = lstatSync(s.dir);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== s.dev || current.ino !== s.ino) {
        skipped.push({ dir: s.dir, name: s.name, reason: 'Identidade do diretório mudou; candidato preservado.' });
        continue;
      }
      if (uid !== null && current.uid !== uid) {
        skipped.push({ dir: s.dir, name: s.name, reason: 'UID do diretório mudou; candidato preservado.' });
        continue;
      }
      try {
        if (listJobs(s.dir, { all: true }).some(isActive)) {
          skipped.push({ dir: s.dir, name: s.name, reason: 'Estado em uso: há jobs ativos.' });
          continue;
        }
        const server = serverStatus(s.dir, deps);
        if (server.reason || server.live) {
          skipped.push({ dir: s.dir, name: s.name, reason: server.reason ?? 'Estado em uso: servidor ativo.' });
          continue;
        }
      } catch (err) {
        skipped.push({ dir: s.dir, name: s.name, reason: `Não foi possível revalidar o estado; candidato preservado (${err.code ?? 'erro de leitura'}).` });
        continue;
      }
      let lastUsed;
      try { lastUsed = newestMtime(s.dir); } catch (err) {
        skipped.push({ dir: s.dir, name: s.name, reason: `Não foi possível reler o estado; candidato preservado (${err.code ?? 'erro de leitura'}).` });
        continue;
      }
      if (Date.now() - lastUsed <= days * DAY_MS) {
        skipped.push({ dir: s.dir, name: s.name, reason: 'Estado atualizado após a listagem; candidato preservado.' });
        continue;
      }
      rmSync(s.dir, { recursive: true, force: false });
      removed.push(s.name);
      removedStates.push(s);
    } catch (err) {
      skipped.push({ dir: s.dir, name: s.name, reason: `Não foi possível remover o estado; candidato preservado (${err.code ?? 'erro'}).` });
    } finally {
      for (const release of held.reverse()) release();
    }
  }
  if (flags.json) ctx.json({ removed, candidates: stale.map(publicCandidate), skipped });
  else {
    const removedTable = renderTable(['Estado', 'Último uso'], removedStates.map((s) => [s.name, s.lastUsed]));
    const summary = removed.length
      ? `Removidos ${removed.length} diretórios de estado:\n\n${removedTable}`
      : 'Nenhum diretório de estado foi removido.';
    ctx.out(`# opc gc\n\n${summary}${skipped.length ? `\n\nPreservados:\n${skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}\n` : '\n'}`);
  }
  return ExitCode.OK;
}

function publicCandidate({ dir, name, lastUsed }) { return { dir, name, lastUsed }; }
