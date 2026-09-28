import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import {
  CLAUDE_SESSION_ORPHAN_MS,
  isClaudeSessionLive,
  liveClaudeSessions,
  loadState,
  registerClaudeSession,
  removeClaudeSession,
} from '../../plugins/opc/scripts/lib/state.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { parseHookInput } from '../../plugins/opc/scripts/lib/args.mjs';
import { contextForCwd, createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const dead = () => null;

function tempDir(t, prefix) {
  return trackTempDir(t, makeTempDir(prefix));
}

test('a session whose pid identity matches is live even after 24 h', () => {
  const me = getProcessIdentity(process.pid);
  assert.equal(isClaudeSessionLive({ pid: process.pid, pidStartTime: me.startTime, startedAt: ago(48 * 3600 * 1000) }, { now }), true);
});

test('a dead pid younger than 24 h still counts as live (fallback, §15 item 9)', () => {
  assert.equal(isClaudeSessionLive({ pid: 999999, pidStartTime: 'x', startedAt: ago(1000) }, { now, identityOf: dead }), true);
});

test('a dead or reused pid older than 24 h is an orphan', () => {
  const old = ago(CLAUDE_SESSION_ORPHAN_MS + 1000);
  assert.equal(isClaudeSessionLive({ pid: 999999, pidStartTime: 'x', startedAt: old }, { now, identityOf: dead }), false);
  const reused = () => ({ pid: 4242, startTime: 'other', cmdline: ['node'] });
  assert.equal(isClaudeSessionLive({ pid: 4242, pidStartTime: 'x', startedAt: old }, { now, identityOf: reused }), false);
  assert.equal(isClaudeSessionLive({ startedAt: 'not a date' }, { now, identityOf: dead }), false);
});

test('a recorded pidComm mismatch is not live even when pid and start time match', () => {
  const identityOf = () => ({ startTime: 'same', cmdline: ['/usr/bin/other-process'] });
  assert.equal(isClaudeSessionLive({ pid: 4242, pidStartTime: 'same', pidComm: 'claude', startedAt: ago(48 * 3600 * 1000) }, { now, identityOf }), false);
});

test('registerClaudeSession replaces the same session id and prunes orphans', async (t) => {
  const dir = tempDir(t, 'opc-sessions-');
  const opts = { now, identityOf: dead };
  await registerClaudeSession(dir, { sessionId: 'orphan', pid: 1, pidStartTime: 'x', startedAt: ago(CLAUDE_SESSION_ORPHAN_MS + 1000) }, opts);
  await registerClaudeSession(dir, { sessionId: 's1', pid: 2, pidStartTime: 'a', startedAt: ago(0) }, opts);
  await registerClaudeSession(dir, { sessionId: 's1', pid: 3, pidStartTime: 'b', startedAt: ago(0) }, opts);
  assert.deepEqual(loadState(dir).claudeSessions.map((entry) => [entry.sessionId, entry.pid]), [['s1', 3]]);
});

test('removeClaudeSession reports removal and liveClaudeSessions filters orphans', async (t) => {
  const dir = tempDir(t, 'opc-sessions-');
  const opts = { now, identityOf: dead };
  await registerClaudeSession(dir, { sessionId: 's1', pid: 2, pidStartTime: 'a', startedAt: ago(0) }, opts);
  await registerClaudeSession(dir, { sessionId: 's2', pid: 3, pidStartTime: 'b', startedAt: ago(0) }, opts);
  assert.equal(await removeClaudeSession(dir, 's1', opts), true);
  assert.equal(await removeClaudeSession(dir, 's1', opts), false);
  assert.deepEqual(liveClaudeSessions(dir, opts).map((entry) => entry.sessionId), ['s2']);
});

test('parseHookInput tolerates empty and invalid input', () => {
  assert.deepEqual(parseHookInput(''), {});
  assert.deepEqual(parseHookInput('   \n'), {});
  assert.deepEqual(parseHookInput('{not json'), {});
  assert.deepEqual(parseHookInput('[1,2]'), {});
  assert.deepEqual(parseHookInput('{"session_id":"abc","reason":"clear"}'), { session_id: 'abc', reason: 'clear' });
});

test('contextForCwd keeps the context for the same workspace and switches state for another', async (t) => {
  const dataDir = tempDir(t, 'opc-data-');
  const wsA = tempDir(t, 'opc-ws-a-');
  const wsB = tempDir(t, 'opc-ws-b-');
  fs.writeFileSync(path.join(wsB, '.opc.json'), JSON.stringify({ defaultModel: 'workspace-b-distinct-model' }));
  const env = { ...process.env, OPC_DATA_DIR: dataDir };
  const ctx = await createContext({ argv: [], env, cwd: wsA, stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
  assert.equal(contextForCwd(ctx, wsA), ctx);
  const other = contextForCwd(ctx, wsB);
  assert.notEqual(other.stateDir, ctx.stateDir);
  assert.equal(other.workspaceRoot, fs.realpathSync(wsB));
  assert.equal(fs.statSync(other.stateDir).mode & 0o777, 0o700);
  assert.equal(other.dataDir, ctx.dataDir);
  assert.equal(other.config.defaultModel, 'workspace-b-distinct-model');
  assert.equal(other.configMeta.workspaceFound, true);
});
