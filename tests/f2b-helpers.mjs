import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, fakeRequests, makeWorkspace } from './helpers.mjs';
import { buildCatalog } from '../plugins/opc/scripts/lib/models.mjs';
import { getProcessIdentity } from '../plugins/opc/scripts/lib/process.mjs';
import { readServerRecord, serverMatcher } from '../plugins/opc/scripts/lib/server.mjs';

// Canonical helpers re-exported (owners: waitFor F0, writeGlobalConfig F1, stateDirFor F2a, fakeRequests F2b in
// tests/helpers.mjs). This module only ADDS F2b-specific helpers and never redefines a tests/helpers.mjs name.
export { fakeRequests, stateDirFor, waitFor, writeGlobalConfig } from './helpers.mjs';

export function gitIn(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

export function writeFile(cwd, rel, content) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// Workspace git with a `main` branch (makeWorkspace may use the machine's default branch name).
export function makeMainRepo(t) {
  const cwd = makeWorkspace(t, { git: true });
  gitIn(cwd, ['branch', '-M', 'main']);
  gitIn(cwd, ['config', 'commit.gpgsign', 'false']);
  return cwd;
}

export function fixtureModelIds() {
  const data = path.join(REPO_ROOT, 'tests', 'fixtures', 'data');
  const catalog = buildCatalog({ providers: JSON.parse(fs.readFileSync(path.join(data, 'provider.json'), 'utf8')),
    models: JSON.parse(fs.readFileSync(path.join(data, 'model.json'), 'utf8')) });
  return catalog.models.filter((model) => catalog.connected.has(model.providerID)).map((model) => model.full);
}

export function readJsonLines(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Invalid JSON in ${file} at line ${index + 1}: ${err.message}`, { cause: err });
    }
  }
  return records;
}

export function promptBodies(env) {
  return fakeRequests(env)
    .filter((request) => request.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(request.path))
    .map((request) => request.body);
}

export function sessionCreateBodies(env) {
  return fakeRequests(env)
    .filter((request) => request.method === 'POST' && request.path === '/api/session')
    .map((request) => request.body);
}

export function promptText(body) {
  return body?.text ?? '';
}

export function makeFailingOpencodeBin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-failbin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'opencode'), '#!/bin/sh\necho "opencode: simulated failure" >&2\nexit 1\n', { mode: 0o755 });
  return dir;
}

export function hookInput(cwd, fields = {}) {
  return JSON.stringify({ cwd, transcript_path: '', ...fields });
}

export function serverAlive(stateDir) {
  const record = readServerRecord(stateDir);
  if (!record) return false;
  const identity = getProcessIdentity(record.pid);
  return Boolean(identity
    && String(identity.startTime) === String(record.startTime)
    && serverMatcher(record.port)(identity.cmdline));
}
