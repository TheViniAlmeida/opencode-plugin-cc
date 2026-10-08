// F10: attach em servidor remoto — recusa de http privado sem a chave e header x-opencode-directory com a raiz remota.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ensureServer, REMOTE_ROOT_IGNORED_WARNING } from '../../plugins/opc/scripts/lib/server.mjs';
import { makeServerCtx, makeWorkspace, readJsonFile, runCli, startExternalFake, testEnv, writeGlobalConfig } from '../helpers.mjs';
import { F3_TEST_CONFIG } from '../fixtures/f3-fake.mjs';

async function attachEnv(t, extra = {}) {
  const env = testEnv(t, { scenario: 'f3-sessions' });
  const external = await startExternalFake(t, { scenario: 'f3-sessions' });
  Object.assign(env, { OPC_SERVER_URL: external.url, OPC_SERVER_PASSWORD: external.password }, extra);
  const ws = makeWorkspace(t, { git: false });
  return { env, ws, external };
}

const workspaceDirectories = (stateFile) => readJsonFile(stateFile).requests
  .filter((r) => r.path.startsWith('/api/session'))
  .map((r) => r.directory);

test('http on a private IP without server.allowPrivateHttp → INSECURE_SERVER_URL (exit 2) before any request', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t, { git: false });
  // Nenhuma conexão é aberta: a URL é recusada antes da rede.
  const r = await runCli(['sessions', '--json'], { env: { ...env, OPC_SERVER_URL: 'http://10.0.0.1:4096' }, cwd: ws });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /INSECURE_SERVER_URL/);
  assert.match(r.stderr, /opc config set server\.allowPrivateHttp true/);
  const dns = await runCli(['sessions', '--json'], { env: { ...env, OPC_SERVER_URL: 'http://server.lan:4096' }, cwd: ws });
  assert.equal(dns.code, 2);
  assert.match(dns.stderr, /IP privado/);
});

test('OPC_REMOTE_ROOT: x-opencode-directory carries the remote root and the git sync warning is shown', async (t) => {
  const { env, ws, external } = await attachEnv(t, { OPC_REMOTE_ROOT: '/srv/remote/repo' });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const r = await runCli(['sessions', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  const dirs = workspaceDirectories(external.stateFile);
  assert.ok(dirs.length > 0, 'the fake saw workspace requests');
  assert.deepEqual([...new Set(dirs)], ['/srv/remote/repo']);
  assert.match(r.stderr, /As ferramentas rodam em \/srv\/remote\/repo na máquina do servidor\. Sincronize via git/);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('server.remoteRoots maps a parent directory: the workspace subdirectory is joined with /', async (t) => {
  const { env, ws, external } = await attachEnv(t);
  const parent = fs.realpathSync(path.dirname(ws));
  writeGlobalConfig(env, { ...F3_TEST_CONFIG, server: { ...(F3_TEST_CONFIG.server ?? {}), remoteRoots: { [parent]: '/srv/work' } } });
  const r = await runCli(['sessions', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...new Set(workspaceDirectories(external.stateFile))], [`/srv/work/${path.basename(ws)}`]);
  const setup = await runCli(['setup', '--json'], { env, cwd: ws });
  assert.equal(JSON.parse(setup.stdout).server.remoteRoot, `/srv/work/${path.basename(ws)}`);
  const text = await runCli(['setup'], { env, cwd: ws });
  assert.match(text.stdout, new RegExp(`- raiz remota: /srv/work/${path.basename(ws)}`));
});

test('without a remote root the local workspace path is sent, as before', async (t) => {
  const { env, ws, external } = await attachEnv(t);
  writeGlobalConfig(env, F3_TEST_CONFIG);
  const r = await runCli(['sessions', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...new Set(workspaceDirectories(external.stateFile))], [fs.realpathSync(ws)]);
  assert.doesNotMatch(r.stderr, /As ferramentas rodam em/);
});

test('an invalid OPC_REMOTE_ROOT is refused with exit 2', async (t) => {
  const { env, ws } = await attachEnv(t, { OPC_REMOTE_ROOT: 'srv/repo' });
  const r = await runCli(['sessions', '--json'], { env, cwd: ws });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /INVALID_REMOTE_ROOT/);
});

test('managed mode ignores OPC_REMOTE_ROOT and warns', async (t) => {
  const { ctx } = makeServerCtx(t, { extraEnv: { OPC_REMOTE_ROOT: '/srv/remote/repo' } });
  const server = await ensureServer(ctx);
  assert.equal(server.attached, false);
  assert.equal(server.remoteRoot, undefined);
  assert.ok(server.warnings.includes(REMOTE_ROOT_IGNORED_WARNING), server.warnings.join(' | '));
});
