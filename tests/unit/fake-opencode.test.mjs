import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadScenario, readStateFile, startFake } from '../fixtures/fake-opencode.mjs';
import { FAKE_BIN_DIR, makeTempDir, runProcess, trackTempDir, waitFor } from '../helpers.mjs';

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
});

test('fake SSE sends server.connected then heartbeats; emit() broadcasts', async (t) => {
  const { fake } = await withFake(t, { heartbeatMs: 30 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${fake.url}/event`, { headers: auth, signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  fake.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
  await waitFor(async () => {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
    return text.includes('server.heartbeat') && text.includes('server.connected');
  }, { message: 'sse frames' });
  assert.match(text, /^data: \{"id":"evt_/);
  assert.equal(fake.state.sseConnections, 1);
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
});
