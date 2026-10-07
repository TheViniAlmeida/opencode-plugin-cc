#!/usr/bin/env node
// Live contract for OpenCode 2.0.22 (F6). Boots its own isolated `opencode serve` (temporary HOME/XDG, own port and
// password, a provider pointing at a closed local port) and checks the facts opc relies on. No inference runs.
// Run: OPC_LIVE=1 [OPC_OPENCODE_BIN=/path/to/opencode] node tests/live/contract-v2.mjs   (exit 1 on any failure)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { newMessageId } from '../../plugins/opc/scripts/lib/runner.mjs';
import { assertShape } from '../fixtures/contract-shapes.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('contract-v2: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

const MIN_VERSION = [2, 0, 22];
const PROVIDER = 'omniroute-personal';
const MODEL = { providerID: PROVIDER, id: 'opencode-go/deepseek-v4.1-flash' };
const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function versionAtLeast(version, min) {
  const parts = String(version).split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i += 1) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
}

// Processes started by this run (the CLI may spawn a background service): matched by the isolated HOME.
function processesWithHome(home) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (env.includes(`HOME=${home}`)) found.push(Number(pid));
    } catch { /* gone or not ours */ }
  }
  return found;
}

const base = makeTempDir('opc-contract-v2-');
const home = path.join(base, 'home');
const ws = path.join(base, 'workspace');
for (const dir of [home, ws, path.join(base, 'config'), path.join(base, 'data'), path.join(base, 'state'), path.join(base, 'cache')]) fs.mkdirSync(dir, { recursive: true });
const password = crypto.randomBytes(18).toString('base64url');
const port = await freePort();
const bin = process.env.OPC_OPENCODE_BIN || 'opencode';
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: path.join(base, 'config'),
  XDG_DATA_HOME: path.join(base, 'data'),
  XDG_STATE_HOME: path.join(base, 'state'),
  XDG_CACHE_HOME: path.join(base, 'cache'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    share: 'disabled',
    provider: { [PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'Contract provider', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: { [MODEL.id]: { name: 'Contract model' } } } },
  }),
};

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    (detail) => results.push({ name, ok: true, detail: detail ?? '' }),
    (error) => results.push({ name, ok: false, detail: error.message }),
  );
}

const url = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
async function call(method, route, { body, headers = {}, withAuth = true } = {}) {
  const res = await fetch(`${url}${route}`, {
    method,
    headers: { ...(withAuth ? { authorization: auth } : {}), 'x-opencode-directory': ws, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, type: res.headers.get('content-type') ?? '', json, text };
}
function expect(condition, message) { if (!condition) throw new Error(message); }

const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
let exitCode = 0;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servidor não ficou pronto em 30 s')), 30000);
    let out = '';
    const onData = (chunk) => {
      out += chunk;
      if (/\bserver listening on https?:\/\/\S+/.test(out)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`servidor saiu antes de ficar pronto (código ${code})`)); });
  });

  await check('GET /api/info: forma e versão mínima 2.0.22', async () => {
    const r = await call('GET', '/api/info');
    expect(r.status === 200 && r.json, `status ${r.status}`);
    assertShape('info', r.json);
    expect(versionAtLeast(r.json.version, MIN_VERSION), `versão ${r.json.version}`);
    return r.json.version;
  });
  await check('sem senha: 401 UnauthorizedError', async () => {
    const r = await call('GET', '/api/info', { withAuth: false });
    expect(r.status === 401 && r.json?._tag === 'UnauthorizedError', `status ${r.status}`);
  });
  await check('rota V1 devolve a SPA em HTML', async () => {
    const r = await call('GET', '/global/health');
    expect(r.status === 200 && /text\/html/.test(r.type), `status ${r.status} ${r.type}`);
  });
  await check('diretório relativo no header é recusado', async () => {
    const r = await call('GET', '/api/agent', { headers: { 'x-opencode-directory': './workspace' } });
    expect(r.status !== 200, `status ${r.status}`);
    return `status ${r.status}`;
  });
  await check('GET /api/config é lista de fontes', async () => {
    const r = await call('GET', '/api/config');
    expect(Array.isArray(r.json) && r.json.every((s) => typeof s.type === 'string'), 'não é lista');
  });
  await check('catálogos: model (variants), agent, provider', async () => {
    // The catalog loads asynchronously after boot: an early GET answers 200 with an empty list.
    const started = Date.now();
    let models = [];
    let mine = null;
    while (!mine && Date.now() - started < 20000) {
      const modelRes = await call('GET', '/api/model');
      expect(modelRes.status === 200, `GET /api/model status ${modelRes.status}`);
      models = modelRes.json?.data ?? [];
      mine = models.find((m) => m.providerID === PROVIDER && m.id === MODEL.id);
      if (!mine) await sleep(500);
    }
    expect(mine, `modelo do provider de contrato ausente (providers: ${[...new Set(models.map((m) => m.providerID))].join(', ')})`);
    assertShape('model', mine);
    expect(Array.isArray(mine.variants), 'variants não é lista');
    for (const a of (await call('GET', '/api/agent')).json?.data ?? []) assertShape('agent', a);
    for (const p of (await call('GET', '/api/provider')).json?.data ?? []) assertShape('provider', p);
    return `catálogo pronto em ${Date.now() - started} ms`;
  });

  let sessionID = null;
  await check('POST /api/session com permissions e model explícitos', async () => {
    const r = await call('POST', '/api/session', { body: { title: 'OPC: contract', agent: 'build', model: MODEL, permissions: RULES } });
    assertShape('session', r.json?.data);
    expect(r.json.data.permissions.length === RULES.length, 'permissions não gravadas');
    sessionID = r.json.data.id;
    return sessionID;
  });
  await check('PATCH permissions substitui a lista', async () => {
    const next = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'glob', resource: '*', effect: 'allow' }];
    const r = await call('PATCH', `/api/session/${sessionID}`, { body: { permissions: next } });
    expect(r.status === 204, `status ${r.status}`);
    const got = (await call('GET', `/api/session/${sessionID}`)).json?.data?.permissions;
    expect(JSON.stringify(got) === JSON.stringify(next), 'lista não substituída');
  });

  const events = [];
  let heartbeats = 0;
  const sse = new AbortController();
  const stream = (async () => {
    const res = await fetch(`${url}/api/event`, { headers: { authorization: auth, 'x-opencode-directory': ws }, signal: sse.signal });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.startsWith(':')) heartbeats += 1;
        else if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial */ } }
      }
    }
  })().catch(() => {});
  await sleep(500);

  const messageID = newMessageId();
  await check('prompt com id do cliente é idempotente', async () => {
    const a = await call('POST', `/api/session/${sessionID}/prompt`, { body: { id: messageID, text: 'contract' } });
    const b = await call('POST', `/api/session/${sessionID}/prompt`, { body: { id: messageID, text: 'contract' } });
    expect(a.json?.data?.id === messageID && b.json?.data?.id === messageID, 'id não preservado');
    await sleep(1500);
    const users = ((await call('GET', `/api/session/${sessionID}/message?order=asc&limit=50`)).json?.data ?? []).filter((m) => m.type === 'user');
    expect(users.length === 1, `${users.length} mensagens de usuário`);
  });
  await check('GET /api/session/active e interrupt', async () => {
    const active = (await call('GET', '/api/session/active')).json?.data ?? {};
    const r = await call('POST', `/api/session/${sessionID}/interrupt`);
    expect(typeof r.json?.interrupted === 'boolean', 'resposta sem interrupted');
    const deadline = Date.now() + 15000;
    let last = null;
    while (Date.now() < deadline) {
      last = ((await call('GET', `/api/session/${sessionID}/message?order=asc&limit=50`)).json?.data ?? []).at(-1);
      if (last?.type === 'idle') break;
      await sleep(500);
    }
    expect(last?.type === 'idle', 'turno não terminou com idle');
    return `active=${JSON.stringify(Object.values(active))} idle=${last.outcome}`;
  });
  await check('SSE: envelope V2 e heartbeat em comentário', async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && heartbeats === 0) await sleep(250);
    sse.abort();
    await stream;
    expect(events[0]?.type === 'server.connected', 'primeiro evento não é server.connected');
    for (const e of events) assertShape('event', e);
    expect(events.some((e) => e.type === 'session.execution.started' && e.data?.sessionID === sessionID), 'execution.started ausente');
    expect(heartbeats > 0, 'nenhum heartbeat em 20 s');
    return `${events.length} eventos, ${heartbeats} heartbeat(s)`;
  });
} catch (error) {
  results.push({ name: 'execução', ok: false, detail: error.message });
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(10000)]);
  const leftovers = processesWithHome(home);
  for (const pid of leftovers) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  results.push({ name: 'servidor encerrado com SIGTERM', ok: child.exitCode !== null || child.signalCode !== null, detail: leftovers.length ? `${leftovers.length} processo(s) extra(s) encerrado(s)` : '' });
  removeTempDir(base);
}

console.log('# Contrato ao vivo OpenCode V2\n');
for (const r of results) {
  console.log(`- ${r.ok ? 'PASSOU' : 'FALHOU'} — ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  if (!r.ok) exitCode = 1;
}
process.exit(exitCode);
