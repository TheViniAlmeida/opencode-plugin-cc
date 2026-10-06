import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { makeTempDir, trackTempDir, waitFor } from '../helpers.mjs';

const PASSWORD = 'sse-hub-password-0123456789';
const FAST_BACKOFF = [20, 20, 20, 20, 20];

async function setup(t, { scenario = 'ok', heartbeatMs = 50, livenessMs = 1000 } = {}) {
  const dir = trackTempDir(t, makeTempDir('opc-sse-'));
  const fake = await startFake({ port: 0, password: PASSWORD, scenario, stateFile: path.join(dir, 'fake.json'), heartbeatMs });
  const client = createClient({ baseUrl: fake.url, password: PASSWORD, directory: dir });
  const hub = new EventHub({ client, livenessMs, backoffMs: FAST_BACKOFF });
  t.after(async () => {
    hub.stop();
    await fake.close();
  });
  return { fake, hub, dir };
}

test('start() resolves after server.connected and sends the V2 route and directory header', async (t) => {
  const { hub, fake, dir } = await setup(t);
  const types = [];
  hub.onAny((e) => types.push(e.type));
  await hub.start();
  assert.equal(hub.state, 'open');
  assert.equal(types[0], 'server.connected');
  const req = fake.state.requests.find((r) => r.path === '/api/event');
  assert.equal(req.directory, dir);
});

test('heartbeat comments keep the stream alive past the liveness window', async (t) => {
  const { fake, hub } = await setup(t, { heartbeatMs: 50, livenessMs: 200 });
  hub.track('ses_none', () => {});
  await hub.start();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fake.state.sseConnections, 1);
  assert.equal(hub.state, 'open');
});

test('track routes events by session and includes children created later', async (t) => {
  const { hub, fake } = await setup(t);
  await hub.start();
  const got = [];
  const untrack = hub.track('ses_root', (e) => got.push(`${e.type}:${e.data.sessionID}`));
  fake.emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root' } });
  fake.emit({ type: 'session.created', data: { sessionID: 'ses_grand', parentID: 'ses_child' } });
  fake.emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_grand', action: 'shell', resources: ['ls'] } });
  fake.emit({ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_other', action: 'shell', resources: ['ls'] } });
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } });
  await waitFor(() => got.includes('session.execution.succeeded:ses_root'), { message: 'evento final roteado' });
  assert.deepEqual(got, [
    'session.created:ses_child',
    'session.created:ses_grand',
    'permission.asked:ses_grand',
    'session.execution.succeeded:ses_root',
  ]);
  untrack();
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.length, 4);
});

for (const scenario of ['sse-drop', 'no-heartbeat']) {
  test(`${scenario}: the hub reconnects and fires onReconnect (resync point)`, async (t) => {
    const { hub, fake } = await setup(t, { scenario, livenessMs: 300 });
    let reconnects = 0;
    const types = [];
    hub.onReconnect(() => { reconnects += 1; });
    hub.onAny((e) => types.push(e.type));
    await hub.start();
    await waitFor(() => reconnects === 1, { timeoutMs: 5000, message: 'reconnect' });
    assert.equal(fake.state.sseConnections, 2);
    assert.equal(hub.state, 'open');
    await waitFor(() => types.filter((x) => x === 'server.connected').length === 2, { message: 'eventos após reconectar' });
  });
}

test('after exhausting the backoff the hub goes down and calls onDown with SERVER_DOWN', async (t) => {
  const { hub, fake } = await setup(t);
  let downErr = null;
  hub.onDown((err) => { downErr = err; });
  await hub.start();
  await fake.close();
  await waitFor(() => downErr, { timeoutMs: 5000, message: 'onDown' });
  assert.equal(downErr.code, 'SERVER_DOWN');
  assert.equal(hub.state, 'down');
});

test('start() rejects with AUTH_FAILED when the password is wrong', async (t) => {
  const { fake } = await setup(t);
  const bad = new EventHub({ client: createClient({ baseUrl: fake.url, password: 'wrong-password-000000' }), backoffMs: FAST_BACKOFF });
  await assert.rejects(bad.start(), (e) => e.code === 'AUTH_FAILED');
  assert.equal(bad.state, 'idle');
});
