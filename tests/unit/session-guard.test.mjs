import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSessionGuard, collectAffectedDiff, PREVIEW_TRUNCATION_NOTICE } from '../../plugins/opc/scripts/commands/session.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';

function tmpState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opc-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

test('collectAffectedDiff merges per-file diffs from the target message onward', async () => {
  const calls = [];
  const api = {
    messages: async () => [
      { info: { id: 'msg_1', role: 'user' } }, { info: { id: 'msg_2', role: 'assistant', parentID: 'msg_1' } },
      { info: { id: 'msg_3', role: 'user' } }, { info: { id: 'msg_4', role: 'assistant', parentID: 'msg_3' } },
    ],
    diff: async (_id, { messageID }) => {
      calls.push(messageID);
      return messageID === 'msg_1'
        ? [{ file: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '+A' }]
        : [{ file: 'a.txt', status: 'modified', additions: 2, deletions: 1, patch: '+B' }, { file: 'b.txt', status: 'added', additions: 1, deletions: 0, patch: '+C' }];
    },
  };
  const fromFirst = await collectAffectedDiff(api, 'ses_a', 'msg_1');
  assert.deepEqual(calls, ['msg_1', 'msg_3']);
  assert.deepEqual(fromFirst.find((d) => d.file === 'a.txt'), { file: 'a.txt', status: 'modified', additions: 3, deletions: 1, patch: '+A\n+B' });
  calls.length = 0;
  await collectAffectedDiff(api, 'ses_a', 'msg_4');
  assert.deepEqual(calls, ['msg_3'], 'assistant target includes its parent user message');
  await assert.rejects(collectAffectedDiff(api, 'ses_a', 'msg_9'), (e) => e.code === 'UNKNOWN_MESSAGE' && e.exitCode === 2);
});

test('collectAffectedDiff validates a message directly when message listing hits the OpenCode bug', async () => {
  const api = {
    messages: async () => { throw Object.assign(new Error('bad list'), { code: 'BAD_REQUEST', details: { body: { message: 'OutputFormatJsonSchema' } } }); },
    message: async (_sessionID, id) => id === 'msg_1' ? { info: { id, role: 'user' } } : Promise.reject(Object.assign(new Error('missing'), { code: 'NOT_FOUND' })),
    diff: async (_id, { messageID }) => [{ file: 'a.txt', patch: `diff ${messageID}` }],
  };
  const preview = await collectAffectedDiff(api, 'ses_a', 'msg_1');
  assert.equal(preview[0].patch, 'diff msg_1');
  assert.match(preview.listBugNotice, /OpenCode 1\.18\.32/);
  await assert.rejects(collectAffectedDiff(api, 'ses_a', 'msg_missing'), (e) => e.code === 'UNKNOWN_MESSAGE');
});

test('collectAffectedDiff marks previews capped at 50 user messages', async () => {
  const messages = [
    { info: { id: 'msg_before_target', role: 'user' } },
    ...Array.from({ length: 51 }, (_, i) => ({ info: { id: `msg_${i}`, role: 'user' } })),
  ];
  const calls = [];
  const api = { messages: async () => messages, diff: async (_sessionID, { messageID }) => { calls.push(messageID); return []; } };
  const preview = await collectAffectedDiff(api, 'ses_a', 'msg_0');
  assert.equal(preview.previewTruncated, true);
  assert.deepEqual(calls, Array.from({ length: 50 }, (_, i) => `msg_${i}`));
  assert.equal(PREVIEW_TRUNCATION_NOTICE, 'Prévia limitada às 50 primeiras mensagens do usuário a partir do alvo; o revert pode afetar mais arquivos.');
});
