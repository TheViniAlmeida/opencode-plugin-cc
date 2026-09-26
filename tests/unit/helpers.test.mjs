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

test('registry aggregates stopper failures and still removes tracked temp dirs', async () => {
  const hooks = [];
  const t = { after(fn) { hooks.push(fn); } };
  const dir = makeTempDir('opc-helper-');
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
  assert.equal(fs.existsSync(dir), false);
});

test('readFakeState defaults only for a missing file and names invalid files in errors', (t) => {
  const missing = makeTempDir('opc-helper-') + '/absent.json';
  assert.deepEqual(readFakeState({ FAKE_OPENCODE_STATE: missing }), {
    requests: [], sessions: {}, messages: {}, permissions: {}, questions: {}, signals: [], sseConnections: 0, bootAttempts: 0, boots: [],
  });
  const dir = trackTempDir(t, makeTempDir('opc-helper-'));
  const invalid = `${dir}/invalid.json`;
  fs.writeFileSync(invalid, '{');
  assert.throws(() => readFakeState({ FAKE_OPENCODE_STATE: invalid }), (err) => err.message.includes(invalid));
});
