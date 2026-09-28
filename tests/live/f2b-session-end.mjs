import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

import { registerStopper } from '../helpers.mjs';
import { readJsonLines, waitFor } from '../f2b-helpers.mjs';
import { getProcessIdentity, isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { readServerRecord, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { resolveWorkspaceRoot, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { LIVE_SKIP, liveCli, livePrepare } from './_f2b-live-helpers.mjs';

function servePids() {
  const result = spawnSync('pgrep', ['-f', 'opencode serve'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).map(Number) : [];
}

test('live F2b: SessionEnd clear keeps the plugin server and the last session end stops it', { skip: LIVE_SKIP, timeout: 10 * 60 * 1000 }, async (t) => {
  const ctx = livePrepare(t, { extra: { OPC_REAP_GRACE_MS: '1000' } });
  const stateDir = workspaceStateDir(ctx.dataDir, resolveWorkspaceRoot(ctx.cwd));
  registerStopper(t, () => stopServer({ stateDir, workspaceRoot: ctx.cwd, config: {}, env: ctx.env, hasActiveJobs: () => false }, { force: true, confirmedByUser: true }));

  const userServers = servePids();
  const started = await liveCli(ctx, ['setup', '--json'], { timeoutMs: 180000 });
  assert.equal(started.code, 0, started.stderr);
  const record = readServerRecord(stateDir);
  assert.ok(record && isPidAlive(record.pid), 'setup must start the plugin server');
  assert.notEqual(record.port, 4096);

  const hook = (sub, fields) => liveCli(ctx, [sub], { stdin: JSON.stringify({ cwd: ctx.cwd, transcript_path: '', ...fields }) });
  const decision = (sessionId) => waitFor(
    () => readJsonLines(path.join(stateDir, 'reaper.log')).find((line) => line.event === 'decision' && line.sessionId === sessionId),
    { timeoutMs: 60000, message: `reaper decision for ${sessionId}` },
  );

  await hook('hook-session-start', { session_id: 'live-a', source: 'startup' });
  const before = performance.now();
  const ended = await hook('hook-session-end', { session_id: 'live-a', reason: 'clear' });
  const elapsed = performance.now() - before;
  assert.equal(ended.code, 0);
  assert.ok(elapsed < 1000, `SessionEnd took ${Math.round(elapsed)} ms`);
  assert.equal((await decision('live-a')).decision, 'keep:reason-clear');
  assert.equal(getProcessIdentity(record.pid)?.startTime, record.startTime, 'same server after /clear');

  await hook('hook-session-start', { session_id: 'live-b', source: 'clear' });
  await hook('hook-session-end', { session_id: 'live-b', reason: 'prompt_input_exit' });
  const last = await decision('live-b');
  assert.equal(last.decision, 'stop');
  await waitFor(() => !isPidAlive(record.pid), { timeoutMs: 30000, message: 'plugin server exit' });
  for (const pid of userServers) assert.ok(isPidAlive(pid), `pre-existing opencode serve ${pid} must survive`);
});
