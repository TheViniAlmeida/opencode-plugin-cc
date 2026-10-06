import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { ensureServer, stopServer, serverMatcher } from '../../plugins/opc/scripts/lib/server.mjs';
import { getProcessIdentity, isPidAlive, terminateProcessGroup } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, trackTempDir, registerStopper } from '../helpers.mjs';

test('I2: stopServer remove attach.secret órfão sem registro', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-orphan-secret-'));
  fs.writeFileSync(join(stateDir, 'attach.secret'), 'fixture-' + 'secret', { mode: 0o600 });
  assert.deepEqual(await stopServer({ stateDir, config: {}, env: {} }), { stopped: false, reason: 'not-running' });
  assert.equal(fs.existsSync(join(stateDir, 'attach.secret')), false);
});

// Real child and identity checks, with a simulated listening announcement and HTTP transport.
// No socket is opened, and the child never reads or prints its password.
async function bootFixture(t) {
  const stateDir = trackTempDir(t, makeTempDir('opc-secret-boot-'));
  const opencodeBin = join(stateDir, 'opencode');
  fs.writeFileSync(opencodeBin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('child.pid', String(process.pid));
console.log('server listening on http://127.0.0.1:43210');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  t.mock.method(net, 'createServer', () => ({
    unref() {}, once() {}, listen(_port, _host, callback) { callback(); },
    address: () => ({ port: 43210 }), close(callback) { callback(); },
  }));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    const data = { '/api/info': { version: '2.0.22' }, '/api/agent': { data: [] }, '/api/model': { data: [{ id: 'test/model' }] }, '/api/config': [{ type: 'document', info: { share: 'manual' } }] };
    assert.ok(Object.hasOwn(data, pathname));
    return new Response(JSON.stringify(data[pathname]));
  });
  const pid = () => Number(fs.readFileSync(join(stateDir, 'child.pid'), 'utf8'));
  registerStopper(t, async () => {
    if (!fs.existsSync(join(stateDir, 'child.pid'))) return;
    const identity = getProcessIdentity(pid());
    if (identity) return terminateProcessGroup(identity, serverMatcher(43210), { graceMs: 500 });
  });
  return { stateDir, pid, ctx: { stateDir, workspaceRoot: stateDir, opencodeBin, env: { PATH: process.env.PATH }, config: {} } };
}

test('I2: boot publica server.json antes de attach.secret', async (t) => {
  const { stateDir, ctx } = await bootFixture(t);
  const rename = fs.renameSync;
  const published = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    if ([join(stateDir, 'server.json'), join(stateDir, 'attach.secret')].includes(to)) published.push(to);
    return rename(from, to);
  });
  await ensureServer(ctx);
  assert.deepEqual(published, [join(stateDir, 'server.json'), join(stateDir, 'attach.secret')]);
  assert.equal(fs.statSync(join(stateDir, 'attach.secret')).mode & 0o777, 0o600);
  assert.equal((await stopServer(ctx)).stopped, true);
});

test('I2: falha ao gravar registro remove segredo e encerra o processo por identidade', async (t) => {
  const { stateDir, ctx, pid } = await bootFixture(t);
  fs.writeFileSync(join(stateDir, 'attach.secret'), 'orphan-' + 'fixture', { mode: 0o600 });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(stateDir, 'server.json')) throw Object.assign(new Error('falha de gravação simulada'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(ensureServer(ctx), /falha de gravação simulada/);
  assert.equal(isPidAlive(pid()), false, 'servidor iniciado deve ser encerrado');
  assert.equal(fs.existsSync(join(stateDir, 'attach.secret')), false);
  assert.equal(fs.existsSync(join(stateDir, 'server.json')), false);
});
