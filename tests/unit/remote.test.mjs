// F10: http em IP privado (opt-in) e raiz remota no modo attach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isPrivateIpLiteral, resolveRemoteRoot, serverDirectory } from '../../plugins/opc/scripts/lib/remote.mjs';
import { attachTransport, INSECURE_URL_MESSAGE } from '../../plugins/opc/scripts/lib/server.mjs';
import {
  coerceValue, isLockedKey, isWorkspaceKey, loadConfig, mergeConfig, validateConfigShape, DEFAULT_CONFIG,
} from '../../plugins/opc/scripts/lib/config.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { isOpcSession } from '../../plugins/opc/scripts/commands/sessions.mjs';
import { runImport } from '../../plugins/opc/scripts/lib/transfer.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

test('isPrivateIpLiteral accepts only private IP literals', () => {
  for (const host of ['10.20.30.40', '10.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '100.127.255.254', '[fd12::1]', 'fd12::1', '[fc00::]', '[FD00:ab::1]']) {
    assert.equal(isPrivateIpLiteral(host), true, host);
  }
  for (const host of ['10.0.0.256', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.128.0.1', '100.63.0.1', 'example.local', 'localhost',
    '127.0.0.1', '[::1]', '[fe80::1]', '[2001:db8::1]', '[::ffff:10.0.0.1]', '010.0.0.1', '10.0.0', '', null, undefined, 42, '[fd12::1%eth0]']) {
    assert.equal(isPrivateIpLiteral(host), false, String(host));
  }
});

test('attachTransport: https and loopback http as before; private http only with the key, with a TLS warning', () => {
  const on = { allowPrivateHttp: true };
  const off = { allowPrivateHttp: false };
  assert.deepEqual(attachTransport(new URL('https://opencode.example.com'), off), { tls: true, warning: null });
  assert.deepEqual(attachTransport(new URL('http://127.0.0.1:4096'), off), { tls: false, warning: null });
  assert.deepEqual(attachTransport(new URL('http://localhost:4096'), off), { tls: false, warning: null });
  const accepted = attachTransport(new URL('http://10.20.30.40:4096'), on);
  assert.equal(accepted.tls, false);
  assert.equal(accepted.warning, 'Conexão sem TLS com 10.20.30.40: a senha e o conteúdo trafegam em claro na rede privada.');
  assert.match(attachTransport(new URL('http://[fd12::1]:4096'), on).warning, /Conexão sem TLS com \[fd12::1\]/);
  assert.throws(() => attachTransport(new URL('http://10.20.30.40:4096'), off), (e) => e.code === 'INSECURE_SERVER_URL' && e.exitCode === 2
    && e.message.includes('opc config set server.allowPrivateHttp true') && /sem TLS/.test(e.message) && /senha/.test(e.message));
  for (const url of ['http://example.com:4096', 'http://8.8.8.8:4096', 'http://server.lan:4096', 'ftp://10.0.0.1']) {
    assert.throws(() => attachTransport(new URL(url), on), (e) => e.code === 'INSECURE_SERVER_URL' && e.message === INSECURE_URL_MESSAGE, url);
  }
  assert.match(INSECURE_URL_MESSAGE, /IP privado/);
  assert.match(INSECURE_URL_MESSAGE, /server\.allowPrivateHttp/);
});

test('serverDirectory: exact root, subdirectory, no map, env override, managed mode ignores everything', () => {
  const ws = path.resolve('/home/dev/projects/repo');
  const config = { server: { remoteRoots: { [ws]: '/srv/repo/' } } };
  assert.equal(serverDirectory({ workspaceRoot: ws, env: {}, config, attached: true }), '/srv/repo');
  const parent = { server: { remoteRoots: { [path.resolve('/home/dev')]: '/srv/dev', [path.resolve('/home/dev/projects')]: '/opt/projects' } } };
  assert.equal(serverDirectory({ workspaceRoot: ws, env: {}, config: parent, attached: true }), '/opt/projects/repo', 'longest mapped root wins');
  assert.equal(serverDirectory({ workspaceRoot: path.resolve('/home/devx/repo'), env: {}, config: parent, attached: true }), path.resolve('/home/devx/repo'), 'a sibling prefix is not a subdirectory');
  assert.equal(serverDirectory({ workspaceRoot: ws, env: {}, config: {}, attached: true }), ws);
  assert.equal(serverDirectory({ workspaceRoot: ws, env: {}, config: DEFAULT_CONFIG, attached: true }), ws);
  assert.equal(serverDirectory({ workspaceRoot: ws, env: { OPC_REMOTE_ROOT: '/data/repo' }, config, attached: true }), '/data/repo');
  assert.equal(serverDirectory({ workspaceRoot: ws, env: { OPC_REMOTE_ROOT: '' }, config, attached: true }), '/srv/repo', 'empty env falls back to the map');
  assert.equal(serverDirectory({ workspaceRoot: ws, env: { OPC_REMOTE_ROOT: '/data/repo' }, config, attached: false }), ws);
  assert.equal(serverDirectory({ workspaceRoot: ws, env: {}, config, attached: false }), ws);
  assert.throws(() => serverDirectory({ workspaceRoot: ws, env: { OPC_REMOTE_ROOT: 'relative/repo' }, config, attached: true }),
    (e) => e.code === 'INVALID_REMOTE_ROOT' && e.exitCode === 2);
  assert.deepEqual(resolveRemoteRoot({ workspaceRoot: ws, env: {}, config, attached: true }), { remoteRoot: '/srv/repo', localRoot: ws, source: 'config' });
  assert.equal(resolveRemoteRoot({ workspaceRoot: ws, env: {}, config, attached: false }), null);
});

test('server.allowPrivateHttp and server.remoteRoots: types, absolute paths, global-only and locked', () => {
  assert.equal(DEFAULT_CONFIG.server.allowPrivateHttp, false);
  assert.deepEqual(DEFAULT_CONFIG.server.remoteRoots, {});
  assert.deepEqual(validateConfigShape({ server: { allowPrivateHttp: true, remoteRoots: { [path.resolve('/home/dev/repo')]: '/srv/repo' } } }).errors, []);
  const errs = (cfg) => validateConfigShape(cfg).errors.map((e) => e.path);
  assert.deepEqual(errs({ server: { allowPrivateHttp: 'yes' } }), ['server.allowPrivateHttp']);
  assert.deepEqual(errs({ server: { remoteRoots: [] } }), ['server.remoteRoots']);
  assert.deepEqual(errs({ server: { remoteRoots: { 'relative/repo': '/srv/repo' } } }), ['server.remoteRoots']);
  assert.deepEqual(errs({ server: { remoteRoots: { [path.resolve('/home/dev/repo')]: 'srv/repo' } } }), ['server.remoteRoots']);
  assert.deepEqual(errs({ server: { remoteRoots: { [path.resolve('/home/dev/repo')]: 7 } } }), ['server.remoteRoots']);
  for (const key of ['server.allowPrivateHttp', 'server.remoteRoots']) {
    assert.equal(isLockedKey(key), true, key);
    assert.equal(isWorkspaceKey(key), false, key);
  }
  assert.equal(coerceValue('server.allowPrivateHttp', 'true'), true);
  assert.deepEqual(coerceValue('server.remoteRoots', '{"/home/dev/repo":"/srv/repo"}'), { '/home/dev/repo': '/srv/repo' });
  assert.throws(() => coerceValue('server.remoteRoots', '{"/home/dev/repo":"srv"}'), (e) => e.code === 'INVALID_VALUE');
  const merged = mergeConfig({}, { server: { allowPrivateHttp: true, remoteRoots: { '/a': '/b' } } });
  assert.equal(merged.config.server.allowPrivateHttp, false, '.opc.json never turns on private http');
  assert.deepEqual(merged.config.server.remoteRoots, {}, '.opc.json never redirects the server directory');
  assert.ok(merged.warnings.some((w) => w.code === 'WORKSPACE_IGNORED' && w.path === 'server'));
  const ws = validateConfigShape({ server: { allowPrivateHttp: true, remoteRoots: {} } }, { source: 'workspace' }).warnings.map((w) => w.path);
  assert.ok(ws.includes('server.allowPrivateHttp') && ws.includes('server.remoteRoots'), ws.join(','));
});

test('loadConfig keeps a workspace .opc.json from enabling private http or remote roots', (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-remote-data-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-remote-ws-'));
  fs.writeFileSync(path.join(workspaceRoot, '.opc.json'), JSON.stringify({ server: { allowPrivateHttp: true, remoteRoots: { [workspaceRoot]: '/' } } }));
  const loaded = loadConfig({ dataDir, workspaceRoot });
  assert.equal(loaded.config.server.allowPrivateHttp, false);
  assert.deepEqual(loaded.config.server.remoteRoots, {});
});

test('http client sends a remote POSIX directory unchanged', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers['x-opencode-directory']); return new Response('{}', { status: 200 }); };
  await createClient({ baseUrl: 'http://127.0.0.1:1', directory: '/srv/repo', fetchImpl }).get('/api/info');
  await createClient({ baseUrl: 'http://127.0.0.1:1', directory: '/srv/repo/', fetchImpl }).get('/api/info');
  assert.deepEqual(seen, ['/srv/repo', '/srv/repo']);
});

test('sessions filter compares location.directory with the directory the server sees', () => {
  const session = { title: 'OPC: ask', location: { directory: '/srv/repo' } };
  assert.equal(isOpcSession(session, '/srv/repo'), true);
  assert.equal(isOpcSession(session, path.resolve('/home/dev/repo')), false);
});

test('runImport passes the server directory to --directory and keeps the local cwd', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, cb) => { calls.push({ args, options }); setImmediate(() => cb(null, 'Imported session: ses_abc123\n', '')); };
  await runImport({ serverUrl: 'http://127.0.0.1:4096', password: 'YOUR_API_KEY_HERE', file: '/f.json', cwd: '/w', directory: '/srv/repo', env: {}, execFileImpl });
  assert.deepEqual(calls[0].args, ['session', 'import', '--server', 'http://127.0.0.1:4096', '--directory', '/srv/repo', '/f.json']);
  assert.equal(calls[0].options.cwd, '/w');
});
