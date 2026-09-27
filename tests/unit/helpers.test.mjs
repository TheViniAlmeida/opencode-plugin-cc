import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { makeTempDir, readFakeState, registerStopper, trackTempDir, waitFor } from '../helpers.mjs';

test('waitFor uses a monotonic clock instead of Date.now', async () => {
  const original = Date.now;
  Date.now = () => { throw new Error('wall clock used'); };
  try {
    assert.equal(await waitFor(async () => 'ready'), 'ready');
  } finally {
    Date.now = original;
  }
});

test('registry preserves recovery directories when a stopper fails', async (outer) => {
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  const order = [];
  registerStopper(t, () => { order.push('first'); });
  registerStopper(t, () => { order.push('second'); throw new Error('stopper broke'); });
  await assert.rejects(hooks[0](), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.match(err.message, /stopper broke/);
    return true;
  });
  assert.deepEqual(order, ['second', 'first']);
  assert.equal(fs.existsSync(dir), true);
});

test('readFakeState defaults only for a missing file and names invalid files in errors', (t) => {
  const missing = trackTempDir(t, makeTempDir('opc-helper-')) + '/absent.json';
  assert.deepEqual(readFakeState({ FAKE_OPENCODE_STATE: missing }), {
    requests: [], sessions: {}, messages: {}, permissions: {}, questions: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [],
  });
  const dir = trackTempDir(t, makeTempDir('opc-helper-'));
  const invalid = `${dir}/invalid.json`;
  fs.writeFileSync(invalid, '{');
  assert.throws(() => readFakeState({ FAKE_OPENCODE_STATE: invalid }), (err) => err.message.includes(invalid));
});

for (const result of [{ stopped: false, reason: 'identity-mismatch' }, { stopped: false, reason: 'active-jobs' }]) {
  test(`cleanup refuses unconfirmed stop: ${result.reason}`, async (outer) => {
    const hooks = [];
    const t = { after(fn) { hooks.push(fn); } };
    const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
    trackTempDir(t, dir);
    registerStopper(t, async () => result);
    await assert.rejects(hooks[0](), /cleanup failed/);
    assert.equal(fs.existsSync(dir), true);
  });
}

test('live cleanup preserves recovery data after rejected or unconfirmed stops', async (t) => {
  const { createServerCleanup } = await import('../helpers.mjs');
  assert.equal(typeof createServerCleanup, 'function');
  for (const failure of [new Error('stop failed'), { stopped: false, reason: 'identity-mismatch' }, undefined]) {
    const dir = trackTempDir(t, makeTempDir('opc-helper-'));
    let calls = 0;
    const cleanup = createServerCleanup(dir, { stop: async () => {
      calls += 1;
      if (calls > 1) return { stopped: true, reason: 'terminated' };
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    const ctx = cleanup.track({ stateDir: dir });
    await assert.rejects(cleanup.stop(ctx));
    await assert.rejects(cleanup.finish(), (err) => err.message.includes(dir));
    assert.equal(fs.existsSync(dir), true, 'even a successful retry must not hide the earlier stop failure');
    assert.equal(calls, 2);
  }
});

test('live cleanup removes data only after every context confirms stop', async (t) => {
  const { createServerCleanup } = await import('../helpers.mjs');
  assert.equal(typeof createServerCleanup, 'function');
  const dir = trackTempDir(t, makeTempDir('opc-helper-'));
  const stopped = [];
  const cleanup = createServerCleanup(dir, { stop: async (ctx) => {
    stopped.push(ctx.stateDir);
    return { stopped: false, reason: 'not-running' };
  } });
  cleanup.track({ stateDir: `${dir}/one` });
  cleanup.track({ stateDir: `${dir}/two` });
  await cleanup.finish();
  assert.deepEqual(stopped, [`${dir}/one`, `${dir}/two`]);
  assert.equal(fs.existsSync(dir), false);
});

test('registry keeps tracked environment data when CLI stop is not confirmed', async (outer) => {
  const { trackEnv, trackWorkspace } = await import('../helpers.mjs');
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  trackWorkspace(t, dir);
  // Attach stop returns code 0 but stopped:false; no sockets or signals are used.
  trackEnv(t, { PATH: process.env.PATH, HOME: dir, OPC_DATA_DIR: `${dir}/data`, OPC_SERVER_URL: 'http://127.0.0.1:1' });
  await assert.rejects(hooks[0](), /test cleanup failed/);
  assert.equal(fs.existsSync(dir), true);
});

test('generic child stoppers may resolve with the child exit code', async (outer) => {
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  registerStopper(t, async () => 0);
  await hooks[0]();
  assert.equal(fs.existsSync(dir), false);
});
