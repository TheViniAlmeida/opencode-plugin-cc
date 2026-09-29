import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import {
  normalizePending, toMonitorEntry, selectJobs, readJobRecords, pickJobId, buildMonitorSnapshot,
  monitorLoop, CLEAR_SCREEN,
} from '../../plugins/opc/scripts/commands/monitor.mjs';

function tempDir(t) { return trackTempDir(t, makeTempDir('opc-f4a-monitor-')); }

test('normalizePending handles permission, question, arrays and null', () => {
  assert.deepEqual(normalizePending(null), []);
  assert.deepEqual(normalizePending({ id: 'per_1', type: 'permission', permission: 'bash', patterns: ['rm -rf build'] }), [
    { id: 'per_1', kind: 'permission', what: 'bash', patterns: ['rm -rf build'] },
  ]);
  assert.deepEqual(normalizePending([{ id: 'que_1', questions: [{ question: 'Which DB?' }, { header: 'Port' }] }]), [
    { id: 'que_1', kind: 'question', what: 'Which DB? | Port', patterns: [] },
  ]);
  assert.deepEqual(normalizePending({ requestID: 'per_2', tool: 'edit', pattern: 'src/*' }), [
    { id: 'per_2', kind: 'permission', what: 'edit', patterns: ['src/*'] },
  ]);
});

test('toMonitorEntry computes attempt n/limit for active and terminal jobs', () => {
  assert.deepEqual(toMonitorEntry({ id: 'a', status: 'running', attemptLimit: 3, attempts: [{}] }).attempt, { current: 2, limit: 3 });
  assert.deepEqual(toMonitorEntry({ id: 'b', status: 'running', attemptLimit: 2, attempts: [{}, {}] }).attempt, { current: 2, limit: 2 });
  assert.deepEqual(toMonitorEntry({ id: 'c', status: 'completed', attemptLimit: 3, attempts: [{}, {}] }).attempt, { current: 2, limit: 3 });
  assert.deepEqual(toMonitorEntry({ id: 'd', status: 'completed' }).attempt, { current: 1, limit: 1 });
  const e = toMonitorEntry({ id: 'e', status: 'failed', errorType: 'X', errorMessage: 'y', pendingRequest: null }, { log: ['l1'] });
  assert.equal(e.errorType, 'X');
  assert.deepEqual(e.pending, []);
  assert.deepEqual(e.log, ['l1']);
});

test('selectJobs puts active first, recent terminal next, groups together, respects limit and focus', () => {
  const jobs = [
    { id: 'old', status: 'completed', createdAt: '1', completedAt: '2026-09-26T10:00:00Z' },
    { id: 'new', status: 'failed', createdAt: '2', completedAt: '2026-09-26T11:00:00Z' },
    { id: 'run', status: 'running', createdAt: '3' },
    { id: 'grp', status: 'running', createdAt: '0' },
    { id: 'mem', status: 'completed', groupId: 'grp', createdAt: '4', completedAt: '2026-09-26T11:30:00Z' },
  ];
  assert.deepEqual(selectJobs(jobs).map((j) => j.id), ['grp', 'mem', 'run', 'new', 'old']);
  assert.deepEqual(selectJobs(jobs, { limit: 3 }).map((j) => j.id), ['grp', 'mem', 'run', 'new']);
  assert.deepEqual(selectJobs(jobs, { focusId: 'grp' }).map((j) => j.id), ['grp', 'mem']);
});

test('selectJobs keeps every member nested under a visible group; limit counts top-level entries', () => {
  const jobs = [
    { id: 'grp', status: 'running', createdAt: '0' },
    { id: 'done-member', status: 'completed', groupId: 'grp', completedAt: '9' },
    { id: 'run-member', status: 'running', groupId: 'grp', createdAt: '1' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `terminal-${i}`, status: 'completed', completedAt: `2026-09-${30 - i}` })),
  ];
  assert.deepEqual(selectJobs(jobs, { limit: 2 }).map((j) => j.id), ['grp', 'done-member', 'run-member', 'terminal-0']);
});

test('readJobRecords merges state.json with job files and skips corrupted files', (t) => {
  const d = tempDir(t);
  fs.mkdirSync(path.join(d, 'jobs'));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ version: 1, jobs: [{ id: 'ask-1', status: 'running' }, { id: 'plan-2', status: 'completed' }] }));
  fs.writeFileSync(path.join(d, 'jobs', 'ask-1.json'), JSON.stringify({ id: 'ask-1', status: 'running', model: 'p/b' }));
  fs.writeFileSync(path.join(d, 'jobs', 'bad.json'), '{not json');
  const records = readJobRecords(d);
  assert.deepEqual(records.map((r) => r.id).sort(), ['ask-1', 'plan-2']);
  assert.equal(records.find((r) => r.id === 'ask-1').model, 'p/b');
  assert.equal(fs.readFileSync(path.join(d, 'jobs', 'bad.json'), 'utf8'), '{not json');
  assert.deepEqual(readJobRecords(path.join(d, 'missing')), []);
});

test('readJobRecords skips unsafe ids, mismatched ids, and input JSON files', (t) => {
  const d = tempDir(t);
  fs.mkdirSync(path.join(d, 'jobs'));
  fs.writeFileSync(path.join(d, 'jobs', 'ask-abc-123456.json'), JSON.stringify({ id: 'ask-abc-123456', status: 'running' }));
  fs.writeFileSync(path.join(d, 'jobs', 'x.json'), JSON.stringify({ id: '../evil', status: 'running' }));
  fs.writeFileSync(path.join(d, 'jobs', 'task-abc-123456.json'), JSON.stringify({ id: 'ask-abc-123456', status: 'failed' }));
  fs.writeFileSync(path.join(d, 'jobs', 'plan-abc-123456.input.json'), JSON.stringify({ id: 'plan-abc-123456', status: 'running' }));
  assert.deepEqual(readJobRecords(d).map((j) => j.id), ['ask-abc-123456']);
});

test('pickJobId resolves exact id or unique prefix; unknown → NOT_FOUND; ambiguous → AMBIGUOUS_JOB', () => {
  const records = [{ id: 'ask-1a' }, { id: 'ask-2b' }, { id: 'plan-3' }];
  assert.equal(pickJobId(records, 'plan'), 'plan-3');
  assert.equal(pickJobId(records, 'ask-1a'), 'ask-1a');
  assert.throws(() => pickJobId(records, 'zzz'), (err) => err.code === 'NOT_FOUND' && err.exitCode === 2);
  assert.throws(() => pickJobId(records, 'ask'), (err) => err.code === 'AMBIGUOUS_JOB' && err.exitCode === 2);
});

test('buildMonitorSnapshot returns entries with log tails, and an empty list without state', (t) => {
  const d = tempDir(t);
  assert.deepEqual(buildMonitorSnapshot(path.join(d, 'missing'), { now: 1 }), { now: 1, focus: null, jobs: [] });
  fs.mkdirSync(path.join(d, 'jobs'));
  fs.writeFileSync(path.join(d, 'jobs', 'ask-1.json'), JSON.stringify({ id: 'ask-1', status: 'running', attemptLimit: 2, attempts: [{}] }));
  // same layout appendJobLog (F2a) writes: "[<iso>] <line>"; readJobProgress strips the prefix
  const at = '[2026-09-26T12:00:00.000Z]';
  fs.writeFileSync(path.join(d, 'jobs', 'ask-1.log'), `${at} a\n${at} b\n${at} c\n${at} d\n`);
  const snap = buildMonitorSnapshot(d, { now: 5 });
  assert.equal(snap.jobs[0].id, 'ask-1');
  assert.deepEqual(snap.jobs[0].attempt, { current: 2, limit: 2 });
  assert.deepEqual(snap.jobs[0].log, ['b', 'c', 'd']);
  assert.deepEqual(buildMonitorSnapshot(d, { now: 5, jobId: 'ask-1' }).jobs[0].log, ['a', 'b', 'c', 'd']);
});

test('monitorLoop --once renders one frame without sleeping', async () => {
  const writes = [];
  const frames = await monitorLoop({
    read: () => ({ n: 1 }), render: (s) => `frame ${s.n}\n`, write: (t) => writes.push(t), once: true,
    sleep: async () => { throw new Error('must not sleep'); },
  });
  assert.equal(frames, 1);
  assert.deepEqual(writes, ['frame 1\n']);
});

test('monitorLoop refreshes every interval until aborted, clearing the screen', async () => {
  const ac = new AbortController();
  const writes = [];
  const sleeps = [];
  let n = 0;
  const frames = await monitorLoop({
    read: () => ({ n: ++n }),
    render: (s) => `frame ${s.n}`,
    write: (t) => writes.push(t),
    intervalMs: 1000,
    clear: true,
    signal: ac.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) ac.abort();
      return !ac.signal.aborted;
    },
  });
  assert.equal(frames, 3);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  assert.deepEqual(writes, [`${CLEAR_SCREEN}frame 1`, `${CLEAR_SCREEN}frame 2`, `${CLEAR_SCREEN}frame 3`]);
});
