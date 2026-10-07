import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { buildAttachArgs, persistManagedAttachSecret, run } from '../../plugins/opc/scripts/commands/attach.mjs';

test('attach builds the V2 TUI command', () => {
  assert.deepEqual(buildAttachArgs({ url: 'http://127.0.0.1:4096', sessionID: 'ses_a', directory: '/w' }), ['--server', 'http://127.0.0.1:4096', '-s', 'ses_a']);
  assert.deepEqual(buildAttachArgs({ url: 'http://127.0.0.1:4096', directory: '/w' }), ['--server', 'http://127.0.0.1:4096']);
});

test('attach rejects extra positionals with the bounded usage preview before opening the API', async () => {
  await assert.rejects(run({}, ['ses_valid', 'unexpected-value-long']), (error) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /Argumento inesperado: unexpected-v…/);
    assert.ok(!error.message.includes('unexpected-value-long'));
    return true;
  });
});

test('attach secret is not recreated if its managed server record disappeared after openApi', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-attach-f3-'));
  const ctx = { stateDir, config: {}, env: {} };
  const server = { url: 'http://127.0.0.1:4100', pid: 1234, startTime: 'identity', port: 4100, password: 'fake-password' };
  fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ schemaVersion: 1, ...server }));
  fs.unlinkSync(path.join(stateDir, 'server.json'));

  await assert.rejects(persistManagedAttachSecret(ctx, server), /registro do servidor.*mudou|não existe/i);
  assert.equal(fs.existsSync(path.join(stateDir, 'attach.secret')), false);
});

test('attach secret is written for the server ensureServer returned (no startTime) and refused after a restart', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-attach-f3-'));
  const ctx = { stateDir, config: {}, env: {} };
  const record = { url: 'http://127.0.0.1:4100', pid: 1234, startTime: 'identity', port: 4100, password: ['fake', 'attach', 'pw'].join('-') };
  fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ schemaVersion: 1, ...record }));
  const returned = { url: record.url, pid: record.pid, port: record.port, password: record.password, attached: false };
  await persistManagedAttachSecret(ctx, returned);
  assert.equal(fs.readFileSync(path.join(stateDir, 'attach.secret'), 'utf8').trim(), record.password);
  fs.unlinkSync(path.join(stateDir, 'attach.secret'));
  fs.writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ schemaVersion: 1, ...record, pid: 5678, password: ['other', 'pw'].join('-') }));
  await assert.rejects(persistManagedAttachSecret(ctx, returned), /mudou/);
  assert.equal(fs.existsSync(path.join(stateDir, 'attach.secret')), false);
});
