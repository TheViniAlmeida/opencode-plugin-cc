#!/usr/bin/env node
// Collects tests/<kind>/**/*.test.mjs (or tests/live/*.mjs) and runs `node --test` — portable to Node 20 and 22.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = Object.freeze(['unit', 'integration', 'live']);
// Not collected in tests/live: support modules (_*.mjs) and standalone scripts (contract.mjs, probe-*.mjs).
const LIVE_NOT_TESTS = /^(_.*|contract|probe-.*)\.mjs$/;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function collectTestFiles(root = REPO_ROOT, kinds = ['unit', 'integration']) {
  const files = [];
  for (const kind of kinds) {
    const dir = path.join(root, 'tests', kind);
    const found = walk(dir, []).filter((f) => {
      const name = path.basename(f);
      if (kind === 'live') return path.dirname(f) === dir && name.endsWith('.mjs') && !LIVE_NOT_TESTS.test(name);
      return name.endsWith('.test.mjs');
    });
    files.push(...found.sort());
  }
  return files;
}

export function supportsTestConcurrency(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function main(argv) {
  const requested = argv[0];
  if (requested && !KINDS.includes(requested)) {
    process.stderr.write(`usage: node scripts/run-tests.mjs [${KINDS.join('|')}]\n`);
    return 2;
  }
  const kinds = requested ? [requested] : ['unit', 'integration'];
  const files = collectTestFiles(REPO_ROOT, kinds);
  if (files.length === 0) {
    process.stderr.write(`no test files found for: ${kinds.join(', ')}\n`);
    return 1;
  }
  const args = ['--test'];
  if (supportsTestConcurrency()) args.push(`--test-concurrency=${requested === 'live' ? 1 : 4}`);
  const env = requested === 'live' ? { ...process.env, OPC_LIVE: '1' } : process.env;
  const res = spawnSync(process.execPath, [...args, ...files], { stdio: 'inherit', env, cwd: REPO_ROOT });
  return res.status ?? 1;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
