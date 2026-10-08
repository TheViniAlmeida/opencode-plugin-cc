#!/usr/bin/env node
// F7 live probes without inference: config precedence, children cursor, fork inheritance, model.updated timing.
// Run: OPC_LIVE=1 [OPC_OPENCODE_BIN=/path/to/opencode] node tests/live/f7-contract.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/lib/opencode-config.mjs';
import { makeTempDir, removeTempDir, REPO_ROOT } from '../helpers.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('f7-contract: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

const PROVIDER = 'omniroute-personal';
const MODELS = ['probe/model-env', 'probe/model-project', 'probe/model-global'];
const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const REPORT = path.join(REPO_ROOT, 'docs/phases/F7-live-output.md');
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/config-precedence.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const base = makeTempDir('opc-f7-contract-');
const home = path.join(base, 'home');
const ws = path.join(base, 'workspace');
const xdgConfig = path.join(base, 'config');
for (const dir of [home, ws, path.join(xdgConfig, 'opencode'), path.join(base, 'data'), path.join(base, 'state'), path.join(base, 'cache')]) fs.mkdirSync(dir, { recursive: true });
const providerModels = Object.fromEntries(MODELS.map((full) => [full.split('/').slice(1).join('/'), { name: full }]));
const provider = { [PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'Probe provider', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: { 'probe/model-env': { name: 'env' }, 'probe/model-project': { name: 'project' }, 'probe/model-global': { name: 'global' } } } };
// Three documents declare a different `model`: global config file, project file, and OPENCODE_CONFIG_CONTENT.
fs.writeFileSync(path.join(xdgConfig, 'opencode', 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/probe/model-global` }));
fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/probe/model-project` }));
const password = crypto.randomBytes(18).toString('base64url');
const port = await freePort();
const env = {
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: path.join(base, 'data'),
  XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', model: `${PROVIDER}/probe/model-env`, provider }),
};
const url = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
async function call(method, route, { body } = {}) {
  const res = await fetch(`${url}${route}`, {
    method,
    headers: { authorization: auth, 'x-opencode-directory': ws, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, data: json?.data ?? json };
}
const sanitize = (value) => JSON.parse(JSON.stringify(value).split(base).join('<tmp>').split(ws).join('<workspace>'));

const facts = {};
const bin = process.env.OPC_OPENCODE_BIN || 'opencode';
const started = performance.now();
const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
let exitCode = 0;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servidor não ficou pronto em 30 s')), 30000);
    let out = '';
    const onData = (chunk) => { out += chunk; if (/\bserver listening on https?:\/\/\S+/.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`servidor saiu antes de ficar pronto (código ${code})`)); });
  });

  // P4: subscribe before the first workspace request and time the first model.updated.
  const events = new AbortController();
  const p4 = (async () => {
    const res = await fetch(`${url}/api/event`, { headers: { authorization: auth, 'x-opencode-directory': ws, accept: 'text/event-stream' }, signal: events.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'stream-ended';
      buffer += decoder.decode(value, { stream: true });
      if (/"type"\s*:\s*"model\.updated"/.test(buffer)) return `${Math.round(performance.now() - started)} ms`;
    }
  })().catch(() => 'none-in-35s');
  const p4Timeout = sleep(35000).then(() => 'none-in-35s');

  // P1: document order and the model the server picks for a session created without one.
  const config = await call('GET', '/api/config');
  const documents = (config.json ?? []).filter((s) => s?.type === 'document').map((s) => s.info?.model ?? null);
  fs.writeFileSync(FIXTURE, `${JSON.stringify(sanitize(config.json), null, 2)}\n`);
  const bare = await call('POST', '/api/session', { body: { title: 'OPC: f7 precedence', permissions: RULES } });
  const picked = bare.data?.model ? `${bare.data.model.providerID}/${bare.data.model.id}` : `status ${bare.status}`;
  const merged = mergeOpencodeConfigSources(config.json ?? []).model ?? null;
  facts['P1-precedence'] = { documents, serverPicked: picked, opcMerge: merged, verdict: picked === merged ? 'last-wins' : (picked === documents.find(Boolean) ? 'first-wins' : 'unknown') };

  // P2: children paging with parentID + cursor.
  const model = { providerID: PROVIDER, id: 'probe/model-env' };
  const parent = await call('POST', '/api/session', { body: { title: 'OPC: f7 parent', permissions: RULES, model } });
  for (let i = 0; i < 3; i += 1) await call('POST', '/api/session', { body: { parentID: parent.data.id, title: `OPC: f7 child ${i}`, permissions: RULES, model } });
  const first = await call('GET', `/api/session?parentID=${parent.data.id}&limit=2`);
  const next = first.json?.cursor?.next;
  const withFilter = next ? await call('GET', `/api/session?parentID=${parent.data.id}&limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const withoutFilter = next ? await call('GET', `/api/session?limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const onlyChildren = (r) => Array.isArray(r?.data) && r.data.every((s) => s.parentID === parent.data.id);
  facts['P2-children-cursor'] = {
    firstPage: first.data?.length ?? null,
    nextCursor: Boolean(next),
    withParentID: withFilter ? { status: withFilter.status, onlyChildren: onlyChildren(withFilter) } : null,
    cursorOnly: withoutFilter ? { status: withoutFilter.status, onlyChildren: onlyChildren(withoutFilter) } : null,
    verdict: !withFilter ? 'no-second-page' : withFilter.status === 400 ? '400' : onlyChildren(withoutFilter) ? 'cursor-keeps-filter' : 'cursor-drops-filter',
  };

  // P3: fork inheritance of permissions and model.
  const forked = await call('POST', `/api/session/${parent.data.id}/fork`, { body: {} });
  const fork = await call('GET', `/api/session/${forked.data.id}`);
  const samePermissions = JSON.stringify(fork.data?.permissions ?? null) === JSON.stringify(RULES);
  const sameModel = fork.data?.model?.id === model.id && fork.data?.model?.providerID === model.providerID;
  facts['P3-fork'] = { permissions: fork.data?.permissions ?? null, model: fork.data?.model ?? null, verdict: samePermissions && sameModel ? 'inherits' : 'missing' };

  facts['P4-model-updated'] = await Promise.race([p4, p4Timeout]);
  events.abort();
} catch (error) {
  exitCode = 1;
  facts.error = error.message;
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  for (const pid of processesWithHome(home)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  removeTempDir(base);
}

const lines = ['', '## f7-contract (sem inferência)', '', '| Fato | Resultado |', '|---|---|',
  ...Object.entries(facts).map(([key, value]) => `| \`${key}\` | \`${JSON.stringify(sanitize(value)).replaceAll('|', '\\|')}\` |`), ''];
fs.appendFileSync(REPORT, lines.join('\n'));
console.log(lines.join('\n'));
process.exit(exitCode);
