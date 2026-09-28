import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { run as setup } from '../../plugins/opc/scripts/commands/setup.mjs';
import { ensureServer, stopServer, assertCanCreateSessions } from '../../plugins/opc/scripts/lib/server.mjs';
import { spawnDetached, terminateProcessGroup, isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, registerStopper, trackTempDir } from '../helpers.mjs';

for (const [scenario, status, body] of [
  ['204', 204, undefined], ['null', 200, null], ['array', 200, []], ['string', 200, 'invalid'],
  ['number', 200, 1], ['unavailable', 503, {}], ['auto', 200, { share: 'auto' }],
  ['disabled', 200, { share: 'disabled' }],
]) {
  test(`config ${scenario}: attach and setup fail closed with correct guidance`, async (t) => {
    const dir = trackTempDir(t, makeTempDir('opc-config-review-'));
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(url).pathname === '/global/health') return new Response(JSON.stringify({ healthy: true, version: '1.18.0' }));
      assert.equal(new URL(url).pathname, '/config');
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    });
    const ctx = { stateDir: dir, workspaceRoot: dir, dataDir: dir, config: {},
      configMeta: {}, configWarnings: [], env: { OPC_SERVER_URL: 'http://127.0.0.1:43210', PATH: '' } };
    const server = await ensureServer(ctx);
    const blocked = scenario !== 'disabled';
    assert.equal(server.world.shareBlocked, blocked);
    const reason = scenario === 'auto' ? 'share-auto' : 'config-unavailable';
    if (blocked) {
      assert.equal(server.world.shareReason, reason);
      assert.throws(() => assertCanCreateSessions(server), { code: 'SHARE_AUTO' });
    } else assert.doesNotThrow(() => assertCanCreateSessions(server));
    let report;
    assert.equal(await setup({ ...ctx, json(value) { report = value; } }, ['--json']), blocked ? 4 : 0);
    assert.equal(report.server.sessionsBlocked, blocked ? reason : null);
    if (blocked && scenario !== 'auto') {
      assert.ok(report.nextSteps.some((s) => /configuração.*compartilhamento/.test(s)));
      assert.ok(!report.nextSteps.some((s) => /Desligue o share/.test(s)));
    }
  });
}

for (const password of [undefined, '', 'fake-dispose-password']) {
  test(`stopServer stops an identity-matched child without a usable password (${JSON.stringify(password)})`, async (t) => {
    const dir = trackTempDir(t, makeTempDir('opc-stop-review-'));
    const script = path.join(dir, 'opencode');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const proc = await spawnDetached(process.execPath, [script, 'serve', '--port', '43210'], {
      cwd: dir, env: process.env, logFile: path.join(dir, 'child.log'),
    });
    registerStopper(t, async () => {
      const result = await terminateProcessGroup(proc, (argv) => argv.includes(script), { graceMs: 500 });
      assert.notEqual(result, 'identity-mismatch', 'test child shutdown must be confirmed');
    });
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1,
      ...proc, port: 43210, url: 'http://127.0.0.1:43210', password }));
    let requests = 0;
    t.mock.method(globalThis, 'fetch', () => { requests += 1; throw new Error('unexpected HTTP request'); });
    const recordPath = path.join(dir, 'server.json');
    const record = fs.readFileSync(recordPath, 'utf8');
    fs.writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(record), startTime: `${proc.startTime}-mismatch` }));
    try {
      assert.deepEqual(await stopServer({ stateDir: dir, config: {}, env: {} }), { stopped: false, reason: 'identity-mismatch' });
      assert.equal(isPidAlive(proc.pid), true, 'stop must preserve a process whose identity no longer matches');
      assert.equal(requests, 0);
    } finally {
      fs.writeFileSync(recordPath, record);
    }
    const result = await stopServer({ stateDir: dir, config: {}, env: {} });
    assert.equal(result.stopped, true);
    assert.equal(requests, 0, 'stop must never send dispose, even with a password');
    assert.equal(isPidAlive(proc.pid), false);
    assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  });
}
