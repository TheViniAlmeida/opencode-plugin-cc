// F8 live checks without inference: attach mode (OPC_SERVER_URL) catalog wait against a real V2 server,
// the V2 shape of enabled/disabled providers, and the transfer resume line executed in a pseudo-terminal
// (attach and managed forms). Run: OPC_LIVE=1 [OPC_OPENCODE_BIN=/path/to/opencode] node --test tests/live/f8-attach.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { cliJson, makeTempDir, REPO_ROOT, stateDirFor, trackEnv, trackTempDir } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';

const SKIP = process.env.OPC_LIVE !== '1' && 'OPC_LIVE!=1';
const BIN = process.env.OPC_OPENCODE_BIN || 'opencode';
const REPORT = path.join(REPO_ROOT, 'docs/phases/F8-live-output.md');
const PROBE = 'probe-gw';
const GHOST = 'ghost-gw';
const DISABLED = 'disabled-gw';
const fakeProvider = (name, models) => ({ npm: '@ai-sdk/openai-compatible', name, options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: Object.fromEntries(models.map((id) => [id, { name: id }])) });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function processesWithHome(home) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) found.push(Number(pid));
    } catch { /* gone or not ours */ }
  }
  return found;
}

function isolatedRoot(t, prefix) {
  const root = trackTempDir(t, makeTempDir(prefix));
  fs.chmodSync(root, 0o700);
  const dirs = { root, home: path.join(root, 'home'), ws: path.join(root, 'ws'), config: path.join(root, 'config'), data: path.join(root, 'data'), state: path.join(root, 'state'), cache: path.join(root, 'cache'), opc: path.join(root, 'opc') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => { for (const pid of processesWithHome(dirs.home)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } });
  return dirs;
}

function baseEnv(dirs, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, OPC_DATA_DIR: dirs.opc, OPC_OPENCODE_BIN: BIN,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', TERM: 'xterm-256color', ...extra,
  };
  return env;
}

// Synthetic Claude transcript under the isolated HOME (transfer only reads ~/.claude/projects).
function writeTranscript(dirs, marker) {
  const projects = path.join(dirs.home, '.claude', 'projects', 'synthetic');
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const source = path.join(projects, 'session.jsonl');
  const rec = (type, content, s) => ({ type, sessionId: 'synthetic-f8', timestamp: `2026-10-08T10:00:0${s}.000Z`, message: { role: type, content } });
  const lines = [{ type: 'custom-title', customTitle: `resume ${marker}` }, rec('user', `Code word ${marker}.`, 0), rec('assistant', [{ type: 'text', text: `Noted ${marker}.` }], 1)];
  fs.writeFileSync(source, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
  return source;
}

// Runs the rendered resume line in a pty for a few seconds and returns the visible text.
function runResumeInPty(command, env, seconds = 12) {
  const res = spawnSync('script', ['-qfec', `stty cols 160 rows 48; ${command}`, '/dev/null'], { env, encoding: 'utf8', timeout: seconds * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  // eslint-disable-next-line no-control-regex
  const text = String(res.stdout ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]|\r/g, '');
  return { text, status: res.status, signal: res.signal, error: res.error?.code ?? null };
}

// Only the screen line that shows the imported session title (the raw pty stream is mostly control output).
const tuiLine = (text, marker) => (text.split('\n').find((l) => l.includes(marker)) ?? '(título não encontrado)').replace(/\s+/g, ' ').trim().slice(0, 200);

async function startServer(dirs, configContent) {
  const port = await freePort();
  const password = crypto.randomBytes(18).toString('base64url');
  const env = baseEnv(dirs, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent) });
  const child = spawn(BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: dirs.ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('serve did not start')), 30_000);
    const onData = (chunk) => { out += chunk; if (/\bserver listening on https?:\/\/\S+/.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited ${code}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const get = async (route) => {
    const r = await fetch(`${url}${route}`, { headers: { authorization: auth, 'x-opencode-directory': dirs.ws }, signal: AbortSignal.timeout(20_000) });
    const json = await r.json().catch(() => null);
    return json?.data ?? json;
  };
  return { url, password, child, get };
}

test('F8 live: attach catalog wait, V2 provider lists and the attach resume line', { skip: SKIP, timeout: 300_000 }, async (t) => {
  const dirs = isolatedRoot(t, 'opc-live-f8-attach-');
  const config = {
    share: 'disabled', plugin: [], mcp: {},
    provider: { [PROBE]: fakeProvider('Probe', ['probe/a']), [GHOST]: { npm: '@ai-sdk/openai-compatible', name: 'Ghost', options: { baseURL: 'http://127.0.0.1:9/v1' }, models: {} }, [DISABLED]: fakeProvider('Disabled', ['disabled/a']) },
    disabled_providers: [DISABLED],
  };
  const server = await startServer(dirs, config);
  t.after(() => server.child.kill('SIGTERM'));
  const safe = (v) => safeOutputText(String(v), dirs.opc).split(dirs.root).join('<isolated>').split(server.password).join('***');

  const infoDocs = (await server.get('/api/config')) ?? [];
  const merged = Object.assign({}, ...infoDocs.filter((d) => d?.type === 'document').map((d) => d.info));
  const catalog = (await server.get('/api/model')) ?? [];
  const catalogProviders = [...new Set(catalog.map((m) => m.providerID))].sort();
  const providerShape = {
    providersKey: Object.keys(merged).filter((k) => /provider/i.test(k)).sort(),
    disabledValue: merged.disabled_providers ?? merged.disabledProviders ?? null,
    catalogHasProbe: catalogProviders.includes(PROBE), catalogHasGhost: catalogProviders.includes(GHOST), catalogHasDisabled: catalogProviders.includes(DISABLED),
  };

  const attachEnv = trackEnv(t, baseEnv(dirs, { OPC_SERVER_URL: server.url, OPC_SERVER_PASSWORD: server.password }));
  const started = performance.now();
  const models = await cliJson(['models'], { env: attachEnv, cwd: dirs.ws, timeoutMs: 60_000 });
  const modelsMs = Math.round(performance.now() - started);
  const modelIds = Array.isArray(models.data?.models) ? models.data.models.map((m) => m.full ?? m.id ?? m) : [];
  const attachCatalog = { exit: models.code, ms: modelsMs, warnsGhost: models.stderr.includes(GHOST) || JSON.stringify(models.data ?? '').includes(GHOST), hasProbe: JSON.stringify(modelIds).includes(PROBE), stderr: safe(models.stderr).slice(-600) };

  const marker = `F8-${Date.now()}`;
  const source = writeTranscript(dirs, marker);
  const transfer = await cliJson(['transfer', '--source', source, '--model', `${PROBE}/probe/a`], { env: attachEnv, cwd: dirs.ws, timeoutMs: 180_000 });
  const resume = transfer.data?.resumeCommand ?? null;
  const pty = resume ? runResumeInPty(resume, attachEnv) : null;
  const attachResume = {
    transferExit: transfer.code, sessionID: transfer.data?.sessionID ?? null,
    usesEnvReference: Boolean(resume?.includes('"$OPC_SERVER_PASSWORD"')), leaksPassword: Boolean(resume?.includes(server.password)),
    tuiShowsTitle: Boolean(pty?.text.includes(marker)), tuiAuthError: /unauthori[sz]ed|401|invalid password/i.test(pty?.text ?? ''), ptyEnd: pty ? (pty.signal ?? pty.error ?? pty.status) : null,
    transferStderr: safe(transfer.stderr).slice(-600),
  };
  appendSafeOutput(REPORT, `### attach: catálogo, providers V2 e linha de retomada\n\n\`\`\`json\n${safe(JSON.stringify({ providerShape, attachCatalog, attachResume }, null, 2))}\n\`\`\`\n\n`, dirs.opc);
  if (pty) appendSafeOutput(REPORT, `#### TUI (attach): linha visível com o título\n\n\`\`\`text\n${safe(tuiLine(pty.text, marker))}\n\`\`\`\n\n`, dirs.opc);

  assert.equal(models.code, 0, safe(models.stderr));
  assert.ok(attachCatalog.hasProbe, 'probe provider missing from the attach catalog');
  assert.ok(attachCatalog.warnsGhost, 'the declared provider without models was not reported');
  assert.equal(transfer.code, 0, safe(transfer.stderr));
  assert.ok(attachResume.usesEnvReference && !attachResume.leaksPassword);
});

test('F8 live: managed resume line opens the imported session in the TUI', { skip: SKIP, timeout: 300_000 }, async (t) => {
  const dirs = isolatedRoot(t, 'opc-live-f8-managed-');
  const env = trackEnv(t, baseEnv(dirs, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', plugin: [], mcp: {}, provider: { [PROBE]: fakeProvider('Probe', ['probe/a']) } }) }));
  const marker = `F8M-${Date.now()}`;
  const source = writeTranscript(dirs, marker);
  const transfer = await cliJson(['transfer', '--source', source, '--model', `${PROBE}/probe/a`], { env, cwd: dirs.ws, timeoutMs: 180_000 });
  const record = JSON.parse(fs.readFileSync(path.join(stateDirFor(env, dirs.ws), 'server.json'), 'utf8'));
  const safe = (v) => safeOutputText(String(v), dirs.opc).split(dirs.root).join('<isolated>').split(record.password).join('***');
  const resume = transfer.data?.resumeCommand ?? null;
  const ptyEnv = { ...env };
  delete ptyEnv.OPENCODE_CONFIG_CONTENT;
  const pty = resume ? runResumeInPty(resume, ptyEnv) : null;
  const managedResume = {
    transferExit: transfer.code, usesSecretFile: Boolean(resume?.includes('attach.secret')), leaksPassword: Boolean(resume?.includes(record.password)),
    tuiShowsTitle: Boolean(pty?.text.includes(marker)), tuiAuthError: /unauthori[sz]ed|401|invalid password/i.test(pty?.text ?? ''), ptyEnd: pty ? (pty.signal ?? pty.error ?? pty.status) : null,
    transferStderr: safe(transfer.stderr).slice(-600),
  };
  appendSafeOutput(REPORT, `### gerenciado: linha de retomada\n\n\`\`\`json\n${safe(JSON.stringify(managedResume, null, 2))}\n\`\`\`\n\n`, dirs.opc);
  if (pty) appendSafeOutput(REPORT, `#### TUI (gerenciado): linha visível com o título\n\n\`\`\`text\n${safe(tuiLine(pty.text, marker))}\n\`\`\`\n\n`, dirs.opc);
  assert.equal(transfer.code, 0, safe(transfer.stderr));
  assert.ok(managedResume.usesSecretFile && !managedResume.leaksPassword);
});
