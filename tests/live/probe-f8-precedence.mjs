#!/usr/bin/env node
// F8 live probes WITH inference (closes P1 / spec §15 items 1, 3, 5): which `model` source a bare session uses
// (global config vs project file vs OPENCODE_CONFIG_CONTENT), whether session permission rules beat the global
// config, and whether PATCH permissions replaces or appends. Uses the operator's OpenCode config read-only
// (HOME/XDG_CONFIG_HOME untouched), with isolated data/state/cache so no session lands in the operator's database.
// Run: OPC_LIVE=1 OPC_LIVE_MODEL=<provider/model> OPC_LIVE_MODEL_2=<provider/model> [OPC_OPENCODE_BIN=…] node tests/live/probe-f8-precedence.mjs
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { makeTempDir, removeTempDir, REPO_ROOT } from '../helpers.mjs';
import { appendSafeOutput } from './_f3-lib.mjs';

const MODEL_PROJECT = process.env.OPC_LIVE_MODEL?.trim();
const MODEL_ENV = process.env.OPC_LIVE_MODEL_2?.trim();
if (process.env.OPC_LIVE !== '1' || !MODEL_PROJECT || !MODEL_ENV || MODEL_PROJECT === MODEL_ENV) {
  console.log('probe-f8-precedence: skipped (set OPC_LIVE=1 and two distinct OPC_LIVE_MODEL / OPC_LIVE_MODEL_2)');
  process.exit(0);
}
const BIN = process.env.OPC_OPENCODE_BIN || 'opencode';
const REPORT = path.join(REPO_ROOT, 'docs/phases/F8-live-output.md');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const split = (full) => { const i = full.indexOf('/'); return { providerID: full.slice(0, i), id: full.slice(i + 1) }; };
const label = (full) => (full === MODEL_PROJECT ? 'project' : full === MODEL_ENV ? 'env' : 'other');
const modelOf = (m) => (typeof m === 'string' ? m : m ? `${m.providerID}/${m.model ?? m.id}` : null);

const base = makeTempDir('opc-f8-precedence-');
const ws = path.join(base, 'ws');
fs.mkdirSync(ws);
for (const d of ['data', 'state', 'cache']) fs.mkdirSync(path.join(base, d));
execFileSync('git', ['init', '-q'], { cwd: ws });
fs.writeFileSync(path.join(ws, 'notes.txt'), 'SECRET-LINE-F8\n');
fs.writeFileSync(path.join(ws, 'opencode.json'), JSON.stringify({ model: MODEL_PROJECT }));
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const password = crypto.randomBytes(18).toString('base64url');
const env = { ...process.env, XDG_DATA_HOME: path.join(base, 'data'), XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', model: MODEL_ENV }) };
for (const k of Object.keys(env)) if (k.startsWith('OPC_')) delete env[k];
const child = spawn(BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
const stopServer = async () => { child.kill('SIGTERM'); await sleep(500); removeTempDir(base); };
await new Promise((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => { stopServer().finally(() => reject(new Error('serve did not start'))); }, 60_000);
  const onData = (c) => { out += c; if (/listening on/.test(out)) { clearTimeout(timer); resolve(); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
});
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'x-opencode-directory': ws };
async function call(method, route, body) {
  const r = await fetch(`${url}${route}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, data: json?.data ?? json };
}
async function waitIdle(id, ms = 180_000) {
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) { const a = (await call('GET', '/api/session/active')).data ?? {}; if (!a[id]) return true; await sleep(1000); }
  return false;
}
const messages = async (id) => (await call('GET', `/api/session/${id}/message?order=asc&limit=100`)).data ?? [];
const facts = {};
try {
  // Global document's model, read-only, model field only (never the rest of the operator config).
  const docs = (await call('GET', '/api/config')).data ?? [];
  const docModels = docs.filter((d) => d?.type === 'document').map((d) => modelOf(d.info?.model));
  const globalModel = docModels.length >= 3 ? docModels[0] : null;

  // P1 / item 5: a session without model, one short turn; which model answered?
  const bare = await call('POST', '/api/session', { title: 'opc f8 precedence (bare)' });
  const bareId = bare.data?.id;
  const sent = await call('POST', `/api/session/${bareId}/prompt`, { text: 'Reply with exactly: ok' });
  const idle = await waitIdle(bareId);
  const msgs = await messages(bareId);
  const assistant = msgs.filter((m) => m.type === 'assistant' || m.role === 'assistant');
  const used = [...new Set(assistant.map((m) => modelOf(m.model ?? (m.providerID ? { providerID: m.providerID, id: m.modelID } : null))).filter(Boolean))];
  const sessionAfter = (await call('GET', `/api/session/${bareId}`)).data;
  facts['P1-bare-session-model'] = {
    createStatus: bare.status, promptStatus: sent.status, idle, documents: docModels.length,
    globalDeclaresModel: Boolean(globalModel), globalIsProjectOrEnv: globalModel ? label(globalModel) : null,
    answeredBy: used.map(label), sessionModel: label(modelOf(sessionAfter?.model)),
    assistantKeys: assistant[0] ? Object.keys(assistant[0]).sort() : [],
    verdict: used.length !== 1 ? 'unknown' : label(used[0]) === 'env' ? 'env-wins' : label(used[0]) === 'project' ? 'project-wins' : 'other (global or default)',
  };

  // Item 3: PATCH permissions twice; does the second replace or append?
  const s3 = await call('POST', '/api/session', { title: 'opc f8 patch', model: split(MODEL_PROJECT), permissions: [{ action: '*', resource: '*', effect: 'deny' }] });
  const id3 = s3.data?.id;
  await call('PATCH', `/api/session/${id3}`, { permissions: [{ action: 'read', resource: '*', effect: 'allow' }] });
  await call('PATCH', `/api/session/${id3}`, { permissions: [{ action: 'glob', resource: '*', effect: 'allow' }] });
  const after3 = (await call('GET', `/api/session/${id3}`)).data?.permissions ?? null;
  facts['item3-patch-permissions'] = { rulesAfter: after3, verdict: Array.isArray(after3) ? (after3.length === 1 && after3[0].action === 'glob' ? 'replaces' : after3.length >= 2 ? 'appends' : 'other') : 'unknown' };

  // Item 1: session rules deny `read` while the global config is the operator's; ask the model to read a file.
  const s1 = await call('POST', '/api/session', { title: 'opc f8 deny read', model: split(MODEL_PROJECT), permissions: [{ action: 'read', resource: '*', effect: 'deny' }, { action: 'bash', resource: '*', effect: 'deny' }] });
  const id1 = s1.data?.id;
  await call('POST', `/api/session/${id1}/prompt`, { text: 'Use the read tool to read the file notes.txt in the current directory and reply with its first line only. Do not use any other tool.' });
  const idle1 = await waitIdle(id1);
  const m1 = await messages(id1);
  const text1 = JSON.stringify(m1);
  const toolParts = m1.flatMap((m) => (m.content ?? []).filter((p) => p.type === 'tool' || p.tool || p.type?.startsWith?.('tool')));
  facts['item1-session-rules'] = {
    idle: idle1, leakedFileContent: text1.includes('SECRET-LINE-F8'),
    toolStates: toolParts.map((p) => ({ tool: p.tool ?? p.name ?? null, status: p.state?.status ?? p.status ?? null, error: String(p.state?.error ?? p.error ?? '').slice(0, 160) || null })),
    messageTypes: m1.map((m) => m.type),
    verdict: text1.includes('SECRET-LINE-F8') ? 'global-or-agent-wins (file read)' : 'session-rules-win (file not read)',
  };
} finally {
  appendSafeOutput(REPORT, `### precedência e permissões (com inferência)\n\n\`\`\`json\n${JSON.stringify(facts, null, 2).split(base).join('<tmp>')}\n\`\`\`\n\n`);
  await stopServer();
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.verdict]))));
