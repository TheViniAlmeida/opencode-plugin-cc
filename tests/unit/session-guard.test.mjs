import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { join } from 'node:path';
import { withSessionGuard, collectAffectedDiff } from '../../plugins/opc/scripts/commands/session.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';

function tmpState(t) {
  return trackTempDir(t, makeTempDir('opc-guard-'));
}

test('withSessionGuard refuses a busy session and releases the lock', async (t) => {
  const stateDir = tmpState(t);
  const api = { sessionStatus: async () => ({ ses_a: { type: 'busy' } }) };
  await assert.rejects(withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), (e) => e.code === 'SESSION_BUSY' && e.exitCode === 2);
  const release = tryAcquireLock(join(stateDir, 'session-ses_a.lock'), { purpose: 'test' });
  assert.ok(release, 'lock must be released after the refusal');
  release();
});

test('withSessionGuard refuses when another holder owns the session lock', async (t) => {
  const stateDir = tmpState(t);
  const release = tryAcquireLock(join(stateDir, 'session-ses_a.lock'), { purpose: 'job' });
  t.after(() => release());
  const api = { sessionStatus: async () => ({}) };
  await assert.rejects(withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), (e) => e.code === 'SESSION_IN_USE');
});

test('withSessionGuard runs fn for an idle session', async (t) => {
  const stateDir = tmpState(t);
  const api = { sessionStatus: async () => ({ ses_a: { type: 'idle' } }) };
  assert.equal(await withSessionGuard({ stateDir }, api, 'ses_a', async () => 'ran'), 'ran');
});

test('revert validation never presents the whole-session diff as target changes', async () => {
  const calls = [];
  const api = {
    messages: async () => [{ id: 'msg_1', type: 'user' }, { id: 'msg_2', type: 'assistant' }],
    diff: async (id) => { calls.push(id); return [{ file: 'a.txt', patch: '+A' }]; },
  };
  const preview = await collectAffectedDiff(api, 'ses_a', 'msg_1');
  assert.equal(preview, null);
  assert.deepEqual(calls, []);
  await assert.rejects(collectAffectedDiff(api, 'ses_a', 'msg_missing'), (error) => error.code === 'UNKNOWN_MESSAGE');
});

test('collectAffectedDiff propagates V2 message listing errors', async () => {
  const api = { messages: async () => { throw Object.assign(new Error('falha na lista'), { code: 'BAD_REQUEST' }); }, diff: async () => [] };
  await assert.rejects(collectAffectedDiff(api, 'ses_a', 'msg_1'), (error) => error.code === 'BAD_REQUEST');
});

test('revert accepts a target after the first 200 V2 messages', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => ({ id: `msg_${i}`, type: 'user' }));
  const calls = [];
  const limits = [];
  const api = { messages: async (_id, { limit }) => { limits.push(limit); return messages.slice(0, limit); }, diff: async (id) => { calls.push(id); return []; } };
  assert.equal(await collectAffectedDiff(api, 'ses_a', 'msg_230'), null);
  // One complete read: the API follows the V2 cursor pages (200 each) instead of growing `limit`.
  assert.deepEqual(limits, [undefined]);
  assert.deepEqual(calls, []);
});
