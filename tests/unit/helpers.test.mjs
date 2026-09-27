import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getProcessIdentity, identityMatches, spawnDetached, terminateProcessGroup } from '../../plugins/opc/scripts/lib/process.mjs';
import { FAKE_BIN_DIR, deadPid, makeTempDir, readFakeState, registerStopper, requireStopped, trackEnv, trackTempDir, waitFor } from '../helpers.mjs';

test('waitFor uses a monotonic clock instead of Date.now', async () => {
  const original = Date.now;
  Date.now = () => { throw new Error('wall clock used'); };
  try {
    assert.equal(await waitFor(async () => 'ready'), 'ready');
  } finally {
    Date.now = original;
  }
});

test('registry closes an external fake and preserves recovery directories when another stopper fails', async (outer) => {
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  const order = [];
  const fake = { close() { order.push('close external fake'); } };
  registerStopper(t, () => fake.close());
  registerStopper(t, () => { order.push('second'); throw new Error('stopper broke'); });
  await assert.rejects(hooks[0](), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.match(err.message, /stopper broke/);
    return true;
  });
  assert.deepEqual(order, ['second', 'close external fake']);
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

test('registry accepts attached CLI stop and removes tracked environment data', async (outer) => {
  const { trackEnv, trackWorkspace } = await import('../helpers.mjs');
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  trackWorkspace(t, dir);
  // Attach stop is a valid end state; no sockets or signals are used.
  trackEnv(t, { PATH: process.env.PATH, HOME: dir, OPC_DATA_DIR: `${dir}/data`, OPC_SERVER_URL: 'http://127.0.0.1:1' });
  await hooks[0]();
  assert.equal(fs.existsSync(dir), false);
});

test('requireStopped accepts attached without stopping an external server', () => {
  const result = { stopped: false, reason: 'attached' };
  assert.equal(requireStopped(result), result);
});

test('registry accepts attached stoppers and removes temporary data', async (outer) => {
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  trackTempDir(t, dir);
  registerStopper(t, () => ({ stopped: false, reason: 'attached' }));
  await hooks[0]();
  assert.equal(fs.existsSync(dir), false);
});

test('requireStopped rejects not-running with a live recorded fake boot and preserves recovery data', async (outer) => {
  const dir = trackTempDir(outer, makeTempDir('opc-helper-'));
  const env = { FAKE_OPENCODE_STATE: path.join(dir, 'fake-state.json') };
  const fakeBin = path.join(FAKE_BIN_DIR, 'opencode');
  // Simulate the fake cmdline without listening on a socket.
  const proc = await spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', fakeBin, 'serve'], {
    env: process.env, cwd: dir, logFile: path.join(dir, 'child.log'),
  });
  const matcher = (argv) => argv.includes(fakeBin) && argv.includes('serve');
  registerStopper(outer, async () => {
    assert.notEqual(await terminateProcessGroup(proc, matcher, { graceMs: 500 }), 'identity-mismatch');
  });
  fs.writeFileSync(env.FAKE_OPENCODE_STATE, JSON.stringify({ boots: [{ pid: await deadPid() }, { pid: proc.pid }] }));
  const result = { stopped: false, reason: 'not-running' };
  assert.throws(() => requireStopped(result, env), /live fake server/);
  assert.equal(identityMatches(proc, matcher), true, 'verification must not signal the fake');

  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  trackTempDir(t, dir);
  trackEnv(t, env);
  registerStopper(t, () => result);
  const output = [];
  const stderr = outer.mock.method(process.stderr, 'write', (chunk) => { output.push(String(chunk)); return true; });
  try {
    await assert.rejects(hooks[0](), /live fake server/);
    assert.equal(fs.existsSync(dir), true);
    assert.ok(output.some((line) => line.includes(dir)), 'retained directory must be printed');
  } finally {
    stderr.mock.restore();
  }
});

test('requireStopped accepts not-running with no live fake boot', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-helper-'));
  const env = { FAKE_OPENCODE_STATE: path.join(dir, 'fake-state.json') };
  const result = { stopped: false, reason: 'not-running' };
  assert.equal(requireStopped(result, env), result, 'missing state means no recorded boots');
  fs.writeFileSync(env.FAKE_OPENCODE_STATE, JSON.stringify({ boots: [] }));
  assert.equal(requireStopped(result, env), result);
  fs.writeFileSync(env.FAKE_OPENCODE_STATE, JSON.stringify({ boots: [{ pid: await deadPid() }, { pid: process.pid }] }));
  assert.ok(getProcessIdentity(process.pid));
  assert.equal(requireStopped(result, env), result, 'dead and unrelated live PIDs are not fake servers');
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
