// opc gc: removes workspace states unused for more than N days, only on explicit command (spec §3.2).
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode } from '../lib/opc-error.mjs';
import { identityMatches } from '../lib/process.mjs';
import { readServerRecord, serverMatcher } from '../lib/server.mjs';
import { createPrompter } from '../lib/tty.mjs';
import { isActive, listJobs } from '../lib/jobs.mjs';
import { renderTable } from '../lib/render.mjs';

const STATE_DIR_RE = /^.+-[0-9a-f]{16}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs;
  const visit = (path, depth) => {
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      try {
        newest = Math.max(newest, lstatSync(full).mtimeMs);
      } catch {
        continue;
      }
      if (entry.isDirectory() && depth < 1) visit(full, depth + 1);
    }
  };
  visit(dir, 0);
  return newest;
}

function hasLiveServer(dir) {
  const record = readServerRecord(dir);
  if (!record?.pid) return false;
  return identityMatches({ pid: record.pid, startTime: record.startTime }, serverMatcher(record.port));
}

export function findStaleStates(dataDir, { olderThanMs, exclude = null, now = Date.now() } = {}) {
  const root = join(dataDir, 'state');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !STATE_DIR_RE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    if (exclude && resolve(dir) === resolve(exclude)) continue;
    if (uid !== null && lstatSync(dir).uid !== uid) continue;
    const lastUsed = newestMtime(dir);
    if (now - lastUsed <= olderThanMs) continue;
    if (listJobs(dir, { all: true }).some(isActive) || hasLiveServer(dir)) continue;
    stale.push({ dir, name: entry.name, lastUsed: new Date(lastUsed).toISOString() });
  }
  return stale.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
}

export async function run(ctx, argv) {
  const { flags } = parseArgs(argv, {
    flags: { json: { type: 'boolean' }, cwd: { type: 'string' }, days: { type: 'number', default: 30 }, 'confirmed-by-user': { type: 'boolean' } },
  });
  const days = Number.isFinite(flags.days) && flags.days > 0 ? flags.days : 30;
  const stale = findStaleStates(ctx.dataDir, { olderThanMs: days * DAY_MS, exclude: ctx.stateDir });
  if (stale.length === 0) {
    if (flags.json) ctx.json({ removed: [], candidates: [] });
    else ctx.out(`opc gc: nenhum estado de workspace sem uso há mais de ${days} dias.\n`);
    return ExitCode.OK;
  }
  const table = renderTable(['Estado', 'Último uso'], stale.map((s) => [s.name, s.lastUsed]));
  let confirmed = Boolean(flags['confirmed-by-user']);
  if (!confirmed) {
    if (!ctx.stdin?.isTTY) {
      if (flags.json) ctx.json({ removed: [], candidates: stale, needsConfirmation: true });
      else ctx.out(`# opc gc\n\nEstes estados seriam removidos:\n\n${table}\n\nNada foi removido. Execute em um terminal ou use --confirmed-by-user após obter confirmação do usuário.\n`);
      return ExitCode.USAGE;
    }
    ctx.err(`# opc gc\n\n${table}\n\n`);
    const prompter = createPrompter({ input: ctx.stdin, output: ctx.stderr });
    try {
      confirmed = await prompter.confirm(`Remover estes ${stale.length} diretórios de estado?`);
    } finally {
      prompter.close();
    }
    if (!confirmed) {
      ctx.out('opc gc: nada foi removido.\n');
      return ExitCode.OK;
    }
  }
  for (const s of stale) rmSync(s.dir, { recursive: true, force: true });
  if (flags.json) ctx.json({ removed: stale.map((s) => s.name), candidates: stale });
  else ctx.out(`# opc gc\n\nRemovidos ${stale.length} diretórios de estado:\n\n${table}\n`);
  return ExitCode.OK;
}
