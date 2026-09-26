import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { loadScenario, readStateFile, startFake, writeStateFile } from '../fixtures/fake-opencode.mjs';
import { FAKE_BIN_DIR, makeTempDir, registerStopper, runProcess, trackTempDir, waitFor } from '../helpers.mjs';

const PASSWORD = 'fake-test-password-0123456789';
const auth = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` };

async function withFake(t, opts = {}) {
  const dir = trackTempDir(t, makeTempDir('opc-fake-'));
  const stateFile = path.join(dir, 'state.json');
  const fake = await startFake({ port: 0, password: PASSWORD, stateFile, ...opts });
  t.after(() => fake.close());
  return { fake, stateFile };
}

test('fake requires Basic auth and serves the F0 routes', async (t) => {
  const { fake, stateFile } = await withFake(t, { configContent: '{"share":"disabled"}' });
  assert.equal((await fetch(`${fake.url}/global/health`)).status, 401);
  assert.deepEqual(await (await fetch(`${fake.url}/global/health`, { headers: auth })).json(), { healthy: true, version: '1.18.32' });
  assert.equal(await (await fetch(`${fake.url}/global/dispose`, { method: 'POST', headers: auth })).json(), true);
  const agents = await (await fetch(`${fake.url}/agent?directory=/x`, { headers: auth })).json();
  // slice: the F1 agent.json keeps these four first and appends more agents
  assert.deepEqual(agents.map((a) => a.name).slice(0, 4), ['build', 'plan', 'general', 'explore']);
  const cfg = await (await fetch(`${fake.url}/config`, { headers: auth })).json();
  assert.equal(cfg.share, 'disabled', 'OPENCODE_CONFIG_CONTENT is merged over the base config');
  assert.deepEqual(await (await fetch(`${fake.url}/session/status`, { headers: auth })).json(), {});
  assert.deepEqual(await (await fetch(`${fake.url}/permission`, { headers: auth })).json(), []);
  assert.deepEqual(await (await fetch(`${fake.url}/question`, { headers: auth })).json(), []);
  assert.equal((await fetch(`${fake.url}/nope`, { headers: auth })).status, 404);
  const state = readStateFile(stateFile);
  assert.ok(state.requests.some((r) => r.path === '/agent' && r.query.directory === '/x'));
  const wrongAuth = { authorization: `Basic ${Buffer.from('opencode:wrong-password').toString('base64')}` };
  assert.equal((await fetch(`${fake.url}/private-probe`, { headers: wrongAuth })).status, 401);
  assert.ok(!readStateFile(stateFile).requests.some((r) => r.path === '/private-probe'));
  assert.equal(readStateFile(stateFile).unauthorized, 2);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(stateFile)).mode & 0o777, 0o700);
});

test('state read distinguishes missing files from corrupt or unreadable files', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-state-'));
  const missing = path.join(dir, 'missing.json');
  assert.equal(readStateFile(missing).bootAttempts, 0);
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{');
  assert.throws(() => readStateFile(corrupt), new RegExp(corrupt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => readStateFile(dir), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('state writes preserve existing directory modes and create new directories as 0700', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-state-mode-'));
  const existing = path.join(dir, 'existing');
  fs.mkdirSync(existing, { mode: 0o755 });
  fs.chmodSync(existing, 0o755);
  writeStateFile(path.join(existing, 'state.json'), { ok: true });
  assert.equal(fs.statSync(existing).mode & 0o777, 0o755);

  const nested = path.join(dir, 'new', 'nested');
  writeStateFile(path.join(nested, 'state.json'), { ok: true });
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
});

test('fake SSE sends server.connected then heartbeats; emit() broadcasts', async (t) => {
  const { fake } = await withFake(t, { heartbeatMs: 30 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${fake.url}/event`, { headers: auth, signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  await waitFor(async () => {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
    return text.includes('server.connected');
  }, { message: 'connected SSE frame' });
  fake.emit({ type: 'x.test', properties: { n: 1 } });
  await waitFor(async () => {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
    const frames = text.split('\n').filter((line) => line.startsWith('data: ')).flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6))];
      } catch {
        return [];
      }
    });
    return text.includes('server.heartbeat') && frames.some((frame) => frame.type === 'x.test' && frame.properties?.n === 1);
  }, { message: 'emitted SSE event and heartbeat' });
  const frames = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.ok(frames.some((frame) => frame.type === 'x.test' && frame.properties.n === 1));
  assert.equal(fake.state.sseConnections, 1);
});

test('scenario setup failure closes its HTTP listener', async () => {
  await assert.rejects(startFake({ scenario: 'setup-throws' }), /setup failure fixture/);
});

test('scenarios override routes and setup', async (t) => {
  const { fake } = await withFake(t, { scenario: 'auth-401' });
  assert.equal((await fetch(`${fake.url}/global/health`, { headers: auth })).status, 401);
  const old = await loadScenario('old-version');
  assert.equal(old.version, '1.17.9');
  await assert.rejects(loadScenario('../evil'), /invalid scenario name/);
});

test('fake binary: --version and serve announce the listening line', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-fakebin-'));
  const bin = path.join(FAKE_BIN_DIR, 'opencode');
  const version = await runProcess(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'ok' } });
  assert.equal(version.stdout.trim(), '1.18.32');
  const oldVersion = await runProcess(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'old-version' } });
  assert.equal(oldVersion.stdout.trim(), '1.17.9');
  const failing = await runProcess(bin, ['serve', '--port', '1', '--hostname', '127.0.0.1'], {
    env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'eaddrinuse', FAKE_OPENCODE_STATE: path.join(dir, 's.json') },
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /EADDRINUSE/);
  assert.equal(readStateFile(path.join(dir, 's.json')).bootAttempts, 1);

  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    env: { ...process.env, FAKE_OPENCODE_SCENARIO: 'ok', FAKE_OPENCODE_STATE: path.join(dir, 'success.json'), OPENCODE_SERVER_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  registerStopper(t, () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  }));
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes(`opencode server listening on http://127.0.0.1:${port}`), { message: 'fake binary listening announcement' });
  assert.match(stdout, new RegExp(`opencode server listening on http://127\\.0\\.0\\.1:${port}`));
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/global/health`, { headers: auth })).json(), { healthy: true, version: '1.18.32' });
});
