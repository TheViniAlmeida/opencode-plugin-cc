import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import {
  MIN_OPENCODE_VERSION, LISTENING_RE, assertCanCreateSessions, compareVersions, pickFreePort, readServerRecord, resolveOpencodeBin, serverMatcher,
} from '../../plugins/opc/scripts/lib/server.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

test('MIN_OPENCODE_VERSION is 2.0.22 and compareVersions orders numerically', () => {
  assert.equal(MIN_OPENCODE_VERSION, '2.0.22');
  assert.equal(compareVersions('1.18.32', '1.18.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.18.0'), -1);
  assert.equal(compareVersions('1.18.0', '1.18.0'), 0);
  assert.equal(compareVersions('v2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.18.32-beta.1', '1.18.32'), 0);
  assert.equal(compareVersions('1.17.9', MIN_OPENCODE_VERSION), -1);
});

test('V2 readiness line, matcher and minimum version', () => {
  assert.equal(MIN_OPENCODE_VERSION, '2.0.22');
  assert.equal('server listening on http://127.0.0.1:4096'.match(LISTENING_RE)[1], 'http://127.0.0.1:4096');
  assert.ok(serverMatcher(4096)(['/home/u/.opencode/bin/opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4096']));
  assert.ok(serverMatcher(4096, '/opt/v2/current')(['/opt/v2/current', 'serve', '--port', '4096']));
  assert.ok(!serverMatcher(4096)(['/usr/bin/node', 'x.mjs', 'serve', '--port', '4096']));
});

test('resolveOpencodeBin prefers the env override, then config, then PATH', () => {
  assert.equal(resolveOpencodeBin({ env: { OPC_OPENCODE_BIN: '/a/opencode' }, config: { server: { opencodeBin: '/b/opencode' } } }), '/a/opencode');
  assert.equal(resolveOpencodeBin({ env: {}, config: { server: { opencodeBin: '/b/opencode' } } }), '/b/opencode');
  assert.equal(resolveOpencodeBin({ env: {}, config: {} }), 'opencode');
});

test('pickFreePort returns a port that can be bound on 127.0.0.1', async () => {
  const port = await pickFreePort();
  assert.ok(port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('serverMatcher accepts only `opencode serve --port <port>` (real binary or node wrapper)', () => {
  const m = serverMatcher(43210);
  assert.equal(m(['opencode', 'serve', '--port', '43210', '--hostname', '127.0.0.1']), true);
  assert.equal(m(['/usr/bin/node', '/x/tests/fixtures/bin/opencode', 'serve', '--port', '43210']), true);
  assert.equal(m(['/home/u/.bun/bin/opencode.exe', 'serve', '--port=43210']), true);
  assert.equal(m(['opencode', 'serve', '--port', '4096']), false);
  assert.equal(m(['opencode', 'serve']), false);
  assert.equal(m(['opencode', 'run', '--port', '43210']), false);
  assert.equal(m(['vim', 'a', 'b', '/tmp/opencode', 'serve', '--port', '43210']), false);
  assert.equal(m([]), false);
  assert.equal(m(null), false);
});

test('readServerRecord returns null for missing, invalid or foreign-schema files', (t) => {
  const dir = makeTempDir('opc-srv-');
  t.after(() => removeTempDir(dir));
  assert.equal(readServerRecord(dir), null);
  fs.writeFileSync(path.join(dir, 'server.json'), '{bad');
  assert.equal(readServerRecord(dir), null);
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 2, pid: 1, port: 2 }));
  assert.equal(readServerRecord(dir), null);
  const record = { schemaVersion: 1, pid: 123, port: 4567, url: 'http://127.0.0.1:4567', password: 'abcdefgh12345678', startTime: '9' };
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(record));
  assert.deepEqual(readServerRecord(dir), record);
  delete record.password;
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(record));
  assert.equal(readServerRecord(dir), null, 'a record without a password is invalid');
  record.password = '';
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(record));
  assert.equal(readServerRecord(dir), null, 'an empty password is invalid');
});

test('assertCanCreateSessions refuses when share is auto (PolicyError, exit 4)', () => {
  assert.doesNotThrow(() => assertCanCreateSessions({ world: { shareBlocked: false } }));
  assert.throws(() => assertCanCreateSessions({ world: { shareBlocked: true } }), (e) => e.code === 'SHARE_AUTO' && e.exitCode === 4);
});
