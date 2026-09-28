import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBridge, createSerialUpdater, queueProgressUpdate, stateWriteFailure, workerFailureState } from '../../plugins/opc/scripts/commands/task-worker.mjs';

function harness({ profileKind = 'write', timeoutMs = 60000, policy = {} } = {}) {
  let job = { status: 'running', phase: 'editing', pendingRequest: null };
  const calls = [];
  const logs = [];
  const bridge = createRequestBridge({
    update: async (patch) => { job = { ...job, ...(typeof patch === 'function' ? patch(job) : patch) }; return job; },
    api: {
      async replyPermission(id, body) { calls.push(['reply', id, body]); return true; },
      async rejectQuestion(id) { calls.push(['rejectQuestion', id]); return true; },
    },
    profileKind, policy, timeoutMs, log: (l) => logs.push(l),
  });
  return { bridge, calls, logs, get job() { return job; } };
}
const perm = (id, patterns = ['rm -rf build'], sessionID = 'ses_1') => ({ id, sessionID, permission: 'bash', patterns, metadata: { command: patterns[0] }, always: [] });

test('serial updater keeps later writes alive and flush rejects with the first write failure', async () => {
  const failure = new Error('write failed once');
  const calls = [];
  const updater = createSerialUpdater('/unused-by-injected-writer', 'task-test-id', {
    writeJob: async (...args) => {
      calls.push(args[2]);
      if (calls.length === 1) throw failure;
    },
  });
  const first = updater.update({ phase: 'one' });
  const second = updater.update({ phase: 'two' });
  await assert.rejects(first, failure);
  await second;
  await assert.rejects(updater.flush(), failure);
  assert.deepEqual(calls.map((patch) => patch.phase), ['one', 'two']);
});

test('progress update handles a rejected write and logs a redacted failure line', async () => {
  const logs = [];
  const updater = createSerialUpdater('/unused-by-injected-writer', 'task-test-id', {
    writeJob: async () => { throw new Error('persistence failed'); },
  });
  await queueProgressUpdate(updater, { phase: 'editing' }, (line) => logs.push(line));
  assert.deepEqual(logs, ['falha ao salvar o progresso da tarefa: persistence failed']);
  await assert.rejects(updater.flush(), /persistence failed/);
});

test('cancel + failed final state write ends failed with STATE_WRITE_FAILED and records cancellation', async () => {
  const updater = createSerialUpdater('/unused-by-injected-writer', 'task-test-id', {
    writeJob: async () => { throw new Error('final write failed'); },
  });
  const cancelJob = { status: 'running', cancelRequestedAt: '2026-09-27T12:00:00Z' };
  await assert.rejects(updater.update({ status: 'cancelled' }), /final write failed/);
  let failure;
  try { await updater.flush(); } catch (err) { failure = stateWriteFailure(err); }
  const { patch, cancellationLog } = workerFailureState(cancelJob, failure);
  assert.equal(patch.status, 'failed');
  assert.equal(patch.errorCode, 'STATE_WRITE_FAILED');
  assert.match(cancellationLog, /cancelamento solicitado/i);
});

test('read-only profile rejects permissions and questions immediately', async () => {
  const h = harness({ profileKind: 'read-only' });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [] });
  assert.deepEqual(h.calls, [['reply', 'per_1', { reply: 'reject', message: 'opc: perfil somente leitura; solicitação recusada' }], ['rejectQuestion', 'que_1']]);
  assert.equal(h.job.status, 'running');
  h.bridge.dispose();
});

test('write profile: pending → waiting_permission with requiresUser; resolution returns to running', async () => {
  const h = harness();
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onPermission(perm('per_2', ['ls']));
  assert.equal(h.job.status, 'waiting_permission');
  assert.deepEqual(h.job.pendingRequest.map((r) => [r.id, r.requiresUser]), [['per_1', true], ['per_2', false]]);
  await h.bridge.onResolved({ requestID: 'per_1', outcome: 'reject' });
  assert.equal(h.job.status, 'waiting_permission');
  await h.bridge.onResolved({ requestID: 'per_2', outcome: 'reject' });
  assert.equal(h.job.status, 'running');
  assert.equal(h.job.pendingRequest, null);
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});

test('timeout rejects with "opc: nenhum aprovador disponível"; questions get question reject', async () => {
  const h = harness({ timeoutMs: 30 });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onQuestion({ id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'Q', header: 'Q', options: [] }] });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(h.calls, [['reply', 'per_1', { reply: 'reject', message: 'opc: nenhum aprovador disponível' }], ['rejectQuestion', 'que_1']]);
  h.bridge.dispose();
});

test('resolution before the timeout cancels the automatic reject', async () => {
  const h = harness({ timeoutMs: 40 });
  await h.bridge.onPermission(perm('per_1'));
  await h.bridge.onResolved({ requestID: 'per_1', outcome: 'once' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});
