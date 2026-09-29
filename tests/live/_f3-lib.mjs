// Shared helpers for F3 live tests (OPC_LIVE=1). Real OpenCode and disposable workspaces.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, stopAllServers, REPO_ROOT } from '../helpers.mjs';
import { registerSecret, redactText } from '../../plugins/opc/scripts/lib/redact.mjs';
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

function sanitize(text, dataDir) {
  if (dataDir) registerServerSecrets(dataDir);
  return redactText(String(text)).split(homedir()).join('~').split(tmpdir()).join('<tmp>');
}

export function record(title, res, dataDir) {
  mkdirSync(dirname(REPORT), { recursive: true });
  const stderr = String(res.stderr ?? '').trim();
  const body = [`### ${title}`, '', `exit ${res.code}`, '', '```', String(res.stdout ?? '').trim(), '```',
    ...(stderr ? ['', 'stderr (fim):', '', '```', stderr.slice(-4000), '```'] : []), '', ''].join('\n');
  appendFileSync(REPORT, sanitize(body, dataDir));
}

export function note(title, obj, dataDir) {
  appendFileSync(REPORT, sanitize(`### ${title}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\n`, dataDir));
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
