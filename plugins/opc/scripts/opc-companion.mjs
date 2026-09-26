#!/usr/bin/env node
// opc companion: single CLI entry point (`opc <subcommand>`). Only the Node guard runs before dynamic imports.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 20;
const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]*$/;

export function nodeVersionOk(version = process.versions.node) {
  return Number(String(version).split('.')[0]) >= MIN_NODE_MAJOR;
}

// Subcommands = the commands/<name>.mjs files (each phase just adds files; no list to keep in sync).
export function listSubcommands() {
  let entries;
  try {
    entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name.slice(0, -'.mjs'.length))
    .filter((name) => SUBCOMMAND_RE.test(name))
    .sort();
}

// Only a validated name that maps to an existing commands/<name>.mjs is ever imported (no arbitrary paths).
export async function loadCommand(sub) {
  const { UsageError } = await import('./lib/opc-error.mjs');
  const name = String(sub ?? '');
  const file = SUBCOMMAND_RE.test(name) ? path.join(COMMANDS_DIR, `${name}.mjs`) : null;
  if (!file || !fs.existsSync(file)) {
    throw new UsageError('USAGE', `Subcomando desconhecido: ${name}. Disponíveis: ${listSubcommands().join(', ')}.`);
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== 'function') throw new UsageError('USAGE', `O subcomando ${name} não exporta run().`);
  return mod;
}

export async function main(rawArgv, io = {}) {
  const {
    stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env,
    cwd: defaultCwd = process.cwd(), onError = null,
  } = io;
  if (!nodeVersionOk()) {
    stderr.write(`opc: Node.js >= ${MIN_NODE_MAJOR} é obrigatório (encontrado ${process.versions.node}).\n`);
    return 2;
  }
  const { resolveArgv, extractCwd } = await import('./lib/args.mjs');
  const { UsageError, toExitCode } = await import('./lib/opc-error.mjs');
  const { renderError } = await import('./lib/render.mjs');
  const { redact } = await import('./lib/redact.mjs');
  let wantsJson = Array.isArray(rawArgv) && rawArgv.includes('--json');
  try {
    const resolved = await resolveArgv(rawArgv, { stdin });
    const { cwd, argv } = extractCwd(resolved);
    const [sub, ...rest] = argv;
    wantsJson ||= rest.includes('--json');
    if (!sub) throw new UsageError('USAGE', `Uso: opc <subcomando> [flags]. Subcomandos: ${listSubcommands().join(', ')}.`);
    const mod = await loadCommand(sub);
    const { createContext } = await import('./lib/context.mjs');
    const ctx = await createContext({ argv: rest, env, cwd: cwd ?? defaultCwd, stdin, stdout, stderr, createDataDir: sub === 'setup' });
    return await mod.run(ctx, rest);
  } catch (err) {
    if (onError) onError(err);
    stderr.write(renderError(err));
    if (wantsJson) {
      stdout.write(`${JSON.stringify(redact({ error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details } }), null, 2)}\n`);
    }
    return toExitCode(err);
  }
}

async function flush(stream) {
  await new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main(process.argv.slice(2));
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}
