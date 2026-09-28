import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStaleStates } from '../../plugins/opc/scripts/commands/gc.mjs';

function makeState(root, name, ageDays, { activeJob = false } = {}) {
  const dir = join(root, 'state', name);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{"version":1,"claudeSessions":[],"jobs":[]}');
  if (activeJob) writeFileSync(join(dir, 'jobs', 'task-abc-123456.json'), JSON.stringify({ id: 'task-abc-123456', status: 'running', createdAt: new Date().toISOString() }));
  const when = new Date(Date.now() - ageDays * 86400000);
  for (const p of [join(dir, 'state.json'), join(dir, 'jobs'), dir]) utimesSync(p, when, when);
  if (activeJob) utimesSync(join(dir, 'jobs', 'task-abc-123456.json'), when, when);
  return dir;
}

test('findStaleStates: returns only old, inactive, non-excluded state dirs with slug-hash names', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'opc-gc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = makeState(root, 'old-0123456789abcdef', 40);
  makeState(root, 'recent-0123456789abcdee', 5);
  makeState(root, 'busy-0123456789abcded', 40, { activeJob: true });
  const current = makeState(root, 'current-0123456789abcdec', 40);
  makeState(root, 'not-a-state-dir', 40);
  const stale = findStaleStates(root, { olderThanMs: 30 * 86400000, exclude: current });
  assert.deepEqual(stale.map((s) => s.dir), [old]);
});
