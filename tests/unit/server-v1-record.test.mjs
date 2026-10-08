import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { spawnDetached, terminateProcessGroup, isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, registerStopper, trackTempDir } from '../helpers.mjs';

async function recordedV1(t) {
  const dir = trackTempDir(t, makeTempDir('opc-v1-record-'));
  const script = path.join(dir, 'opencode');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const proc = await spawnDetached(process.execPath, [script, 'serve', '--port', '43211'], { cwd: dir, env: process.env, logFile: path.join(dir, 'child.log') });
  registerStopper(t, async () => terminateProcessGroup(proc, (argv) => argv.includes(script), { graceMs: 500 }));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1, ...proc, port: 43211, url: 'http://127.0.0.1:43211', version: '1.18.34', password: 'fixture-only' }));
  t.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  return { dir, proc, script };
}

test('a recorded opc V1 server is shut down instead of failing every command with NOT_JSON', async (t) => {
  const { dir, proc, script } = await recordedV1(t);
  const config = { server: { opencodeBin: path.join(dir, 'missing-opencode'), bootTimeoutSec: 1 } };
  await assert.rejects(ensureServer({ stateDir: dir, workspaceRoot: dir, config, env: {}, opencodeBin: script }), (error) => {
    assert.notEqual(error.code, 'NOT_JSON');
    return true;
  });
  assert.equal(isPidAlive(proc.pid), false, 'the V1 server was stopped');
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('with active jobs a recorded V1 server is kept and the command is refused', async (t) => {
  const { dir, proc, script } = await recordedV1(t);
  await assert.rejects(ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: {}, opencodeBin: script, hasActiveJobs: () => true }), { code: 'V1_SERVER_ACTIVE' });
  assert.equal(isPidAlive(proc.pid), true);
});
