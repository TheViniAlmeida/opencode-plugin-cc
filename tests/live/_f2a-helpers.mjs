// Shared helpers for F2a live tests. Uses a real OpenCode server and disposable workspaces.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTempDir, makeWorkspace, runCli, trackEnv, trackTempDir } from '../helpers.mjs';
import { resolveWorkspaceRoot, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { readServerRecord } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

export const LIVE = process.env.OPC_LIVE === '1';
export const LIVE_MODEL = process.env.OPC_LIVE_MODEL?.trim() ?? '';
export const LIVE_TIMEOUT_MS = 10 * 60 * 1000;
export const LIVE_SKIP = !LIVE_MODEL
  ? 'OPC_LIVE_MODEL não definida; informe provider/model para executar os testes ao vivo.'
  : !LIVE && 'OPC_LIVE!=1';

export function liveSetup(t, { files = {} } = {}) {
  if (!LIVE || !LIVE_MODEL) throw new Error('liveSetup requires OPC_LIVE=1 and OPC_LIVE_MODEL');
  const ctx = {};
  ctx.cwd = makeWorkspace(t, { git: true, name: 'opc-f2a-live' });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ctx.cwd, path)), { recursive: true });
    writeFileSync(join(ctx.cwd, path), content);
  }
  const dataDir = trackTempDir(t, makeTempDir('opc-f2a-live-data-'));
  ctx.env = trackEnv(t, {
    ...process.env,
    OPC_DATA_DIR: dataDir,
    OPC_COMPANION_SESSION_ID: `live-f2a-${randomBytes(4).toString('hex')}`,
  });
  delete ctx.env.OPC_SERVER_URL;
  delete ctx.env.OPC_INSIDE_SERVER;
  const providerID = LIVE_MODEL.split('/')[0];
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    defaultProvider: providerID,
    defaultModel: LIVE_MODEL,
    policy: { approver: 'user', permissionTimeoutSec: 600 },
  }, null, 2), { mode: 0o600 });
  return ctx;
}

export const opcLive = (ctx, args, { stdin = '', timeoutMs = LIVE_TIMEOUT_MS } = {}) => runCli(args, {
  env: ctx.env,
  cwd: ctx.cwd,
  stdin,
  timeoutMs,
});

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function jobIdIn(text) {
  return /\b((?:task|ask|plan)-[0-9a-z]+-[0-9a-z]{6})\b/.exec(text)?.[1] ?? null;
}

export function liveJob(ctx, id) {
  if (!id) throw new Error('job id not found in command output');
  return readJob(workspaceStateDir(ctx.env.OPC_DATA_DIR, resolveWorkspaceRoot(ctx.cwd)), id);
}

export function liveApi(ctx) {
  const record = readServerRecord(workspaceStateDir(ctx.env.OPC_DATA_DIR, resolveWorkspaceRoot(ctx.cwd)));
  if (!record) throw new Error('no server record: run an opc command first');
  return createApi(createClient({
    baseUrl: record.url,
    password: record.password,
    directory: resolveWorkspaceRoot(ctx.cwd),
    requestTimeoutMs: 60000,
  }));
}

export async function atLeast(need, of, label, fn) {
  const outcomes = [];
  for (let i = 0; i < of && outcomes.filter(Boolean).length < need; i += 1) {
    let passed = false;
    try {
      passed = Boolean(await fn(i));
    } catch (err) {
      console.log(`LIVE-DETAIL ${label} run ${i + 1}: ${err.message}`);
    }
    outcomes.push(passed);
    console.log(`LIVE-DETAIL ${label} run ${i + 1}: ${passed ? 'pass' : 'fail'}`);
  }
  const passes = outcomes.filter(Boolean).length;
  console.log(`LIVE-RESULT ${label}: ${passes >= need ? 'PASSOU' : 'FALHOU'} (${passes}/${outcomes.length})`);
  return passes >= need;
}

export function report(label, passed, detail = '') {
  console.log(`LIVE-RESULT ${label}: ${passed ? 'PASSOU' : 'FALHOU'}${detail ? ` — ${detail}` : ''}`);
}
