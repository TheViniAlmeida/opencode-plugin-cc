import test from 'node:test';
import assert from 'node:assert/strict';

import { listJobs } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { resolveWorkspaceRoot, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { LIVE_SKIP, LIVE_TIMEOUT_MS, liveCli, livePrepare } from './_f2b-live-helpers.mjs';

test('live F2b: rescue resumes the candidate session with --resume-last', { skip: LIVE_SKIP, timeout: 2 * LIVE_TIMEOUT_MS }, async (t) => {
  const sessionId = `live-rescue-${Date.now()}`;
  const ctx = livePrepare(t, { extra: { OPC_COMPANION_SESSION_ID: sessionId } });

  const none = JSON.parse((await liveCli(ctx, ['task-resume-candidate', '--json'])).stdout);
  assert.equal(none.available, false);

  const first = await liveCli(ctx, ['task', '--wait-timeout', '900', '--raw-args-stdin'], {
    stdin: '--\nResponda apenas com a palavra READY e não faça mais nada.\n',
    timeoutMs: LIVE_TIMEOUT_MS,
  });
  assert.equal(first.code, 0, first.stdout + first.stderr);

  const candidate = JSON.parse((await liveCli(ctx, ['task-resume-candidate', '--json'])).stdout);
  assert.equal(candidate.available, true);
  assert.equal(candidate.sessionId, sessionId);

  const second = await liveCli(ctx, ['task', '--resume-last', '--wait-timeout', '900', '--raw-args-stdin'], {
    stdin: '--\nAgora responda apenas com a palavra AGAIN.\n',
    timeoutMs: LIVE_TIMEOUT_MS,
  });
  assert.equal(second.code, 0, second.stdout + second.stderr);

  const stateDir = workspaceStateDir(ctx.dataDir, resolveWorkspaceRoot(ctx.cwd));
  const tasks = listJobs(stateDir, { all: true })
    .filter((job) => job.kind === 'task')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  assert.equal(tasks.length, 2);
  assert.equal(candidate.candidate.id, tasks[0].id);
  assert.equal(tasks[1].sessionID, tasks[0].sessionID, 'resume must keep the OpenCode session');
});
