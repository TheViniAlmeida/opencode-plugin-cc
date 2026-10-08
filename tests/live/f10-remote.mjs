// F10 live checks without inference: attach over plain http to a server bound on a private IP of this host
// (server.allowPrivateHttp) and a remote root (OPC_REMOTE_ROOT) pointing at a git clone that stands in for the
// server-side checkout. Run: OPC_LIVE=1 [OPC_LIVE_PRIVATE_IP=10.x.y.z] [OPC_OPENCODE_BIN=…] node --test tests/live/f10-remote.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cliJson, makeTempDir, REPO_ROOT, trackEnv, trackTempDir, writeGlobalConfig } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';

const BIN = process.env.OPC_OPENCODE_BIN || 'opencode';
const REPORT = path.join(REPO_ROOT, 'docs/phases/F10-live-output.md');
const PROBE = 'probe-gw';
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const privateIp = process.env.OPC_LIVE_PRIVATE_IP
  || Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && PRIVATE_V4.test(a.address))?.address;
const SKIP = process.env.OPC_LIVE !== '1' ? 'OPC_LIVE!=1' : !privateIp && 'no private IPv4 on this host';

function freePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function isolatedRoot(t) {
  const root = trackTempDir(t, makeTempDir('opc-live-f10-'));
  fs.chmodSync(root, 0o700);
  const dirs = { root, home: path.join(root, 'home'), local: path.join(root, 'local'), remote: path.join(root, 'remote'), config: path.join(root, 'config'), data: path.join(root, 'data'), state: path.join(root, 'state'), cache: path.join(root, 'cache'), opc: path.join(root, 'opc') };
  for (const [key, dir] of Object.entries(dirs)) if (key !== 'remote') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The "remote" checkout is a git clone of the local repo: the same project synced via git, at another path.
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'opc', GIT_AUTHOR_EMAIL: 'opc@example.invalid', GIT_COMMITTER_NAME: 'opc', GIT_COMMITTER_EMAIL: 'opc@example.invalid' } });
  git(['init', '-q', '-b', 'main'], dirs.local);
  fs.writeFileSync(path.join(dirs.local, 'notes.txt'), 'F10 remote root\n');
  git(['add', '.'], dirs.local);
  git(['commit', '-q', '-m', 'init'], dirs.local);
  git(['clone', '-q', dirs.local, dirs.remote], root);
  return dirs;
}

const baseEnv = (dirs, extra = {}) => ({
  PATH: process.env.PATH, HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state,
  XDG_CACHE_HOME: dirs.cache, OPC_DATA_DIR: dirs.opc, OPC_OPENCODE_BIN: BIN, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', ...extra,
});

async function startServer(dirs) {
  const port = await freePort(privateIp);
  const password = crypto.randomBytes(18).toString('base64url');
  const config = { share: 'disabled', plugin: [], mcp: {}, provider: { [PROBE]: { npm: '@ai-sdk/openai-compatible', name: 'Probe', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fake-provider-key' }, models: { 'probe/a': { name: 'probe/a' } } } } };
  const child = spawn(BIN, ['serve', '--hostname', privateIp, '--port', String(port)], { cwd: dirs.remote, env: baseEnv(dirs, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('serve did not start')), 30_000);
    const onData = (chunk) => { out += chunk; if (/\bserver listening on https?:\/\/\S+/.test(out)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`serve exited ${code}`)); });
  });
  const url = `http://${privateIp}:${port}`;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const get = async (route, directory) => {
    const r = await fetch(`${url}${route}`, { headers: { authorization: auth, 'x-opencode-directory': directory }, signal: AbortSignal.timeout(20_000) });
    const json = await r.json().catch(() => null);
    return json?.data ?? json;
  };
  return { url, password, child, get };
}

test('F10 live: http attach on a private IP and a remote root synced via git', { skip: SKIP, timeout: 300_000 }, async (t) => {
  const dirs = isolatedRoot(t);
  const server = await startServer(dirs);
  t.after(() => server.child.kill('SIGTERM'));
  const safe = (v) => safeOutputText(String(v), dirs.opc).split(dirs.root).join('<isolated>').split(server.password).join('***').split(privateIp).join('<private-ip>');
  const attach = (extra = {}) => trackEnv(t, baseEnv(dirs, { OPC_SERVER_URL: server.url, OPC_SERVER_PASSWORD: server.password, ...extra }));

  // 1. Private http without the opt-in is refused before any request.
  writeGlobalConfig({ OPC_DATA_DIR: dirs.opc }, { server: { allowPrivateHttp: false } });
  const refused = await cliJson(['models'], { env: attach(), cwd: dirs.local, timeoutMs: 60_000 });
  // 2. With the opt-in and OPC_REMOTE_ROOT: catalog, TLS warning, remote-root warning.
  writeGlobalConfig({ OPC_DATA_DIR: dirs.opc }, { server: { allowPrivateHttp: true } });
  const remoteEnv = attach({ OPC_REMOTE_ROOT: dirs.remote });
  const models = await cliJson(['models'], { env: remoteEnv, cwd: dirs.local, timeoutMs: 60_000 });
  // 3. A session created from the local checkout lands in the remote root on the server.
  const created = await cliJson(['session', 'new', '--title', 'opc f10 remote root', '--model', `${PROBE}/probe/a`], { env: remoteEnv, cwd: dirs.local, timeoutMs: 60_000 });
  const sessionID = created.data?.sessionID ?? created.data?.id ?? created.data?.session?.id ?? null;
  const info = sessionID ? await server.get(`/api/session/${sessionID}`, dirs.remote) : null;
  const listed = await cliJson(['sessions'], { env: remoteEnv, cwd: dirs.local, timeoutMs: 60_000 });
  // 4. Same through server.remoteRoots (no env), keyed by the local checkout.
  writeGlobalConfig({ OPC_DATA_DIR: dirs.opc }, { server: { allowPrivateHttp: true, remoteRoots: { [dirs.local]: dirs.remote } } });
  const mapped = await cliJson(['session', 'new', '--title', 'opc f10 remote map', '--model', `${PROBE}/probe/a`], { env: attach(), cwd: dirs.local, timeoutMs: 60_000 });
  const mappedID = mapped.data?.sessionID ?? mapped.data?.id ?? mapped.data?.session?.id ?? null;
  const mappedInfo = mappedID ? await server.get(`/api/session/${mappedID}`, dirs.remote) : null;

  // 5. transfer with a remote root: the import must land in the remote root too.
  const projects = path.join(dirs.home, '.claude', 'projects', 'synthetic');
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const source = path.join(projects, 'session.jsonl');
  const marker = `F10-${Date.now()}`;
  const rec = (type, content, sec) => ({ type, sessionId: 'synthetic-f10', timestamp: `2026-10-08T10:00:0${sec}.000Z`, message: { role: type, content } });
  fs.writeFileSync(source, `${[{ type: 'custom-title', customTitle: `remote ${marker}` }, rec('user', `Code word ${marker}.`, 0), rec('assistant', [{ type: 'text', text: `Noted ${marker}.` }], 1)].map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
  const transfer = await cliJson(['transfer', '--source', source, '--model', `${PROBE}/probe/a`], { env: remoteEnv, cwd: dirs.local, timeoutMs: 180_000 });
  const imported = transfer.data?.sessionID ? await server.get(`/api/session/${transfer.data.sessionID}`, dirs.remote) : null;

  const facts = {
    refusedWithoutOptIn: { exit: refused.code, insecureUrl: /INSECURE_SERVER_URL/.test(`${refused.stderr}${JSON.stringify(refused.data ?? '')}`), hint: /allowPrivateHttp/.test(`${refused.stderr}${JSON.stringify(refused.data ?? '')}`) },
    attachPrivateHttp: { exit: models.code, hasProbe: JSON.stringify(models.data ?? '').includes(PROBE), tlsWarning: /TLS/.test(models.stderr), remoteWarning: /git/i.test(models.stderr), stderr: safe(models.stderr).slice(-800) },
    remoteRootEnv: { exit: created.code, sessionDirectoryIsRemote: info?.location?.directory === dirs.remote, sessionDirectory: safe(info?.location?.directory ?? null), stderr: safe(created.stderr).slice(-600), listedByOpc: JSON.stringify(listed.data ?? '').includes(sessionID ?? '\u0000') },
    remoteRootsConfig: { exit: mapped.code, sessionDirectoryIsRemote: mappedInfo?.location?.directory === dirs.remote },
    transferRemoteRoot: { exit: transfer.code, leaksPassword: Boolean(transfer.data?.resumeCommand?.includes(server.password)), usesEnvReference: Boolean(transfer.data?.resumeCommand?.includes('"$OPC_SERVER_PASSWORD"')), importedDirectoryIsRemote: imported?.location?.directory === dirs.remote, resumeCommand: safe(transfer.data?.resumeCommand ?? null), stderr: safe(transfer.stderr).slice(-600) },
  };
  appendSafeOutput(REPORT, `### attach http em IP privado e raiz remota (sem inferência)\n\n\`\`\`json\n${safe(JSON.stringify(facts, null, 2))}\n\`\`\`\n`, dirs.opc);

  assert.equal(refused.code, 2, safe(refused.stderr));
  assert.ok(facts.refusedWithoutOptIn.insecureUrl && facts.refusedWithoutOptIn.hint);
  assert.equal(models.code, 0, safe(models.stderr));
  assert.ok(facts.attachPrivateHttp.hasProbe && facts.attachPrivateHttp.tlsWarning && facts.attachPrivateHttp.remoteWarning, safe(models.stderr));
  assert.equal(created.code, 0, safe(created.stderr));
  assert.ok(facts.remoteRootEnv.sessionDirectoryIsRemote, facts.remoteRootEnv.sessionDirectory);
  assert.ok(facts.remoteRootEnv.listedByOpc, 'opc sessions does not list the remote-root session');
  assert.equal(mapped.code, 0, safe(mapped.stderr));
  assert.ok(facts.remoteRootsConfig.sessionDirectoryIsRemote);
  assert.equal(transfer.code, 0, safe(transfer.stderr));
  assert.ok(facts.transferRemoteRoot.importedDirectoryIsRemote, 'transfer did not import into the remote root');
  assert.ok(facts.transferRemoteRoot.usesEnvReference && !facts.transferRemoteRoot.leaksPassword);
});
