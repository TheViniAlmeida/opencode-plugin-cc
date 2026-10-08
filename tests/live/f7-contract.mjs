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
const [MODEL_ENV, MODEL_PROJECT, MODEL_GLOBAL] = MODELS;
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
const provider = { [PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'Probe provider', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: Object.fromEntries(MODELS.map((id) => [id, { name: id }])) } };
// Three documents declare a different `model`: global config file, project file, and OPENCODE_CONFIG_CONTENT.
fs.writeFileSync(path.join(xdgConfig, 'opencode', 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/${MODEL_GLOBAL}` }));
fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify({ model: `${PROVIDER}/${MODEL_PROJECT}` }));
const password = crypto.randomBytes(18).toString('base64url');
const port = await freePort();
const env = {
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: path.join(base, 'data'),
  XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', model: `${PROVIDER}/${MODEL_ENV}`, provider }),
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
// The workspace lives inside the temp base, so replace it first.
const sanitize = (value) => JSON.parse(JSON.stringify(value).split(ws).join('<workspace>').split(base).join('<tmp>'));
// V2 normalizes `model` to { providerID, model }; sessions use { providerID, id }. Compare as "provider/model" strings.
const modelId = (m) => {
  if (typeof m === 'string') return m || null;
  const name = m?.model ?? m?.id;
  return m?.providerID && name ? `${m.providerID}/${name}` : null;
};

const facts = {};
const bin = process.env.OPC_OPENCODE_BIN || 'opencode';
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
    const p4Start = performance.now();
    const res = await fetch(`${url}/api/event`, { headers: { authorization: auth, 'x-opencode-directory': ws, accept: 'text/event-stream' }, signal: events.signal });
    if (!res.ok) return `stream-error: status ${res.status}`;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'stream-ended';
      buffer += decoder.decode(value, { stream: true });
      if (/"type"\s*:\s*"model\.updated"/.test(buffer)) return `${Math.round(performance.now() - p4Start)} ms`;
    }
  })().catch((error) => `stream-error: ${error.message}`);
  const p4Timeout = sleep(35000).then(() => 'none-in-35s');

  // P1: document order and the model the server picks for a session created without one.
  const config = await call('GET', '/api/config');
  const sources = Array.isArray(config.json) ? config.json : [];
  if (sources.length > 0) fs.writeFileSync(FIXTURE, `${JSON.stringify(sanitize(sources), null, 2)}\n`);
  else facts['P1-config-error'] = { status: config.status, reason: 'GET /api/config sem fontes; fixture não gravada' };
  const documents = sources.filter((s) => s?.type === 'document').map((s) => modelId(s.info?.model));
  const declared = documents.filter(Boolean);
  const bare = await call('POST', '/api/session', { body: { title: 'OPC: f7 precedence', permissions: RULES } });
  const bareSession = modelId(bare.data?.model) ?? `no-model (status ${bare.status})`;
  // Probe only: the catalog default is never an execution model.
  const fallback = await call('GET', '/api/model/default');
  const defaultModel = modelId(fallback.data);
  const winner = defaultModel ?? modelId(bare.data?.model);
  const verdict = !winner ? 'unknown' : winner === declared.at(-1) ? 'last-wins' : winner === declared[0] ? 'first-wins' : 'unknown';
  facts['P1-precedence'] = { documents, bareSession, defaultModel, opcMerge: modelId(mergeOpencodeConfigSources(sources).model), verdict };

  // P2: children paging with parentID + cursor.
  const model = { providerID: PROVIDER, id: MODEL_ENV };
  const parent = await call('POST', '/api/session', { body: { title: 'OPC: f7 parent', permissions: RULES, model } });
  for (let i = 0; i < 3; i += 1) await call('POST', '/api/session', { body: { parentID: parent.data.id, title: `OPC: f7 child ${i}`, permissions: RULES, model } });
  const first = await call('GET', `/api/session?parentID=${parent.data.id}&limit=2`);
  const next = first.json?.cursor?.next;
  const withFilter = next ? await call('GET', `/api/session?parentID=${parent.data.id}&limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const withoutFilter = next ? await call('GET', `/api/session?limit=2&cursor=${encodeURIComponent(next)}`) : null;
  const onlyChildren = (r) => Array.isArray(r?.data) && r.data.length > 0 && r.data.every((s) => s.parentID === parent.data.id);
  facts['P2-children-cursor'] = {
    firstPage: first.data?.length ?? null,
    nextCursor: Boolean(next),
    withParentID: withFilter ? { status: withFilter.status, length: withFilter.data?.length ?? null, onlyChildren: onlyChildren(withFilter) } : null,
    cursorOnly: withoutFilter ? { status: withoutFilter.status, length: withoutFilter.data?.length ?? null, onlyChildren: onlyChildren(withoutFilter) } : null,
    verdict: !withFilter ? 'no-second-page' : withFilter.status === 400 ? '400' : onlyChildren(withoutFilter) ? 'cursor-keeps-filter' : 'cursor-drops-filter',
  };

  // P3: fork inheritance of permissions and model, with the parent as control.
  const parentNow = await call('GET', `/api/session/${parent.data.id}`);
  const forked = await call('POST', `/api/session/${parent.data.id}/fork`, { body: {} });
  const fork = await call('GET', `/api/session/${forked.data.id}`);
  const parentHasPermissions = Array.isArray(parentNow.data?.permissions) && parentNow.data.permissions.length > 0;
  const parentHasModel = Boolean(modelId(parentNow.data?.model));
  const samePermissions = JSON.stringify(fork.data?.permissions ?? null) === JSON.stringify(parentNow.data?.permissions ?? null);
  const sameModel = modelId(fork.data?.model) === modelId(parentNow.data?.model);
  facts['P3-fork'] = {
    parent: { permissions: parentHasPermissions, model: modelId(parentNow.data?.model) },
    fork: { permissions: fork.data?.permissions ?? null, model: modelId(fork.data?.model) },
    verdict: !parentHasPermissions || !parentHasModel ? 'parent-lacks' : samePermissions && sameModel ? 'inherits' : 'missing',
  };

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
