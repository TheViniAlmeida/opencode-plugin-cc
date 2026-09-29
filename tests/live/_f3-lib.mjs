// Shared helpers for F3 live tests (OPC_LIVE=1). Real OpenCode and disposable workspaces.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, stopAllServers, REPO_ROOT } from '../helpers.mjs';
import { registerSecret, safeOutputText as redactSafeOutputText } from '../../plugins/opc/scripts/lib/redact.mjs';
import { workspaceStateDir, resolveWorkspaceRoot } from '../../plugins/opc/scripts/lib/state.mjs';

export const LIVE = process.env.OPC_LIVE === '1';
export const LIVE_MODEL = process.env.OPC_LIVE_MODEL?.trim() ?? '';
export const SKIP = !LIVE_MODEL
  ? 'OPC_LIVE_MODEL não definida; informe provider/model para executar os testes ao vivo.'
  : !LIVE && 'OPC_LIVE!=1';
export const MODELS = Object.freeze({
  deepseek: LIVE_MODEL,
  qwen: process.env.OPC_LIVE_MODEL_2?.trim() || LIVE_MODEL,
  kimi: process.env.OPC_LIVE_MODEL_3?.trim() || LIVE_MODEL,
});
export const REPORT = join(REPO_ROOT, 'docs/phases/F3-live-output.md');

export function liveWorkspace(t, { name = 'ws' } = {}) {
  if (!LIVE || !LIVE_MODEL) throw new Error('liveWorkspace requer OPC_LIVE=1 e OPC_LIVE_MODEL');
  const root = mkdtempSync(join(tmpdir(), 'opc-live-f3-'));
  const ws = join(root, name);
  const dataDir = join(root, 'data');
  mkdirSync(ws);
  mkdirSync(dataDir, { mode: 0o700 });
  const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'opc-live');
  git('config', 'user.email', 'opc-live@example.invalid');
  writeFileSync(join(ws, 'notes.txt'), 'original\n');
  writeFileSync(join(ws, 'README.md'), '# Live F3 workspace\n\nDisposable repository for opc F3 live tests.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const env = { ...process.env, OPC_DATA_DIR: dataDir, OPC_COMPANION_SESSION_ID: `live-f3-${randomBytes(4).toString('hex')}` };
  delete env.OPC_SERVER_URL;
  delete env.OPC_SERVER_PASSWORD;
  t.after(() => stopAllServers(env, ws));
  return { root, ws, env, dataDir, stateDir: () => workspaceStateDir(dataDir, resolveWorkspaceRoot(ws)) };
}

export function opc(args, { env, cwd, stdin = '', timeoutMs = 20 * 60_000 } = {}) {
  return runCli(args, { env, cwd, stdin, timeoutMs });
}

export function registerServerSecrets(dataDir) {
  const stateRoot = join(dataDir, 'state');
  if (!existsSync(stateRoot)) return;
  for (const dir of readdirSync(stateRoot)) {
    const file = join(stateRoot, dir, 'server.json');
    if (existsSync(file)) registerSecret(JSON.parse(readFileSync(file, 'utf8')).password);
  }
}

export function safeOutputText(text, dataDir) {
  if (dataDir) registerServerSecrets(dataDir);
  return redactSafeOutputText(String(text)).split(homedir()).join('~').split(tmpdir()).join('<tmp>');
}

export function appendSafeOutput(file, text, dataDir) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, safeOutputText(text, dataDir));
}

export function record(title, res, dataDir) {
  mkdirSync(dirname(REPORT), { recursive: true });
  const stderr = String(res.stderr ?? '').trim();
  const body = [`### ${title}`, '', `exit ${res.code}`, '', '```', String(res.stdout ?? '').trim(), '```',
    ...(stderr ? ['', 'stderr (fim):', '', '```', stderr.slice(-4000), '```'] : []), '', ''].join('\n');
  appendSafeOutput(REPORT, body, dataDir);
}

export function note(title, obj, dataDir) {
  appendSafeOutput(REPORT, `### ${title}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\n`, dataDir);
}

export function assertModelRouting(members, expectedModels) {
  if (!Array.isArray(members) || members.length !== expectedModels.length) throw new Error(`expected ${expectedModels.length} members`);
  for (let i = 0; i < expectedModels.length; i += 1) {
    if (members[i].model !== expectedModels[i]) throw new Error(`member ${i + 1} model ${members[i].model} does not match ${expectedModels[i]}`);
  }
  const distinct = new Set(expectedModels).size;
  if (distinct === 3 && new Set(members.map((member) => member.model)).size !== 3) throw new Error('three distinct configured models did not run distinctly');
  return distinct === 3
    ? 'rotas distintas: 3 (três modelos PASSOU)'
    : `rotas distintas: ${distinct} (três modelos NÃO VALIDADO)`;
}

export function assertIntervalsOverlap(intervals) {
  const events = [];
  for (const interval of intervals) {
    const start = Date.parse(interval.startedAt);
    const end = Date.parse(interval.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invalid interval timestamps');
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let maxParallel = 0;
  for (const event of events) {
    active += event.delta;
    maxParallel = Math.max(maxParallel, active);
  }
  if (maxParallel < 2) throw new Error(`intervals do not overlap (maxParallel=${maxParallel})`);
  return maxParallel;
}

export function compareShapes(real, fake, readPaths) {
  const divergences = [];
  const notApplicable = [];
  const compared = [];
  for (const [endpoint, paths] of Object.entries(readPaths)) {
    if (real[endpoint] == null || fake[endpoint] == null) {
      const reason = endpoint === 'todo' && real[endpoint] == null
        ? 'real server returned no todos; todos cannot be forced deterministically'
        : real[endpoint] == null && fake[endpoint] == null ? 'both real and fake endpoint values were absent' : `${real[endpoint] == null ? 'real' : 'fake'} endpoint value was absent`;
      notApplicable.push({ endpoint, reason });
      continue;
    }
    compared.push(endpoint);
    for (const path of paths) {
      const get = (obj, key) => (key === '' ? obj : key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), obj));
      const r = get(real[endpoint], path);
      const f = get(fake[endpoint], path);
      if (r === undefined && f === undefined) continue;
      if (r === undefined || f === undefined || typeof r !== typeof f || Array.isArray(r) !== Array.isArray(f)) {
        divergences.push({ endpoint, path: path || '(value)', real: r === undefined ? 'missing' : (Array.isArray(r) ? 'array' : typeof r), fake: f === undefined ? 'missing' : (Array.isArray(f) ? 'array' : typeof f) });
      }
    }
  }
  return { divergences, compared, notApplicable };
}

export function assertEndpointCoverage(result, endpoints) {
  const covered = [...result.compared, ...result.notApplicable.map((entry) => entry.endpoint)];
  if (new Set(covered).size !== covered.length || covered.length !== endpoints.length || endpoints.some((endpoint) => !covered.includes(endpoint)))
    throw new Error(`endpoint coverage mismatch: expected ${endpoints.join(', ')}, got ${covered.join(', ')}`);
  for (const entry of result.notApplicable) {
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error(`endpoint ${entry.endpoint} has no notApplicable reason`);
  }
}

export function fileLines(file) {
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function treeChecksum(ws) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ws, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(join(ws, f))).update('\0');
  return hash.digest('hex');
}

export function parseList(stdout, key) {
  const data = JSON.parse(stdout);
  return Array.isArray(data) ? data : (data[key] ?? data.items ?? []);
}

export const userText = (m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
