import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { findStaleStates, run } from '../../plugins/opc/scripts/commands/gc.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { spawn } from 'node:child_process';

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

function rootFor(t) {
  return trackTempDir(t, makeTempDir('opc-gc-'));
}

test('findStaleStates: returns only old, inactive, non-excluded state dirs with slug-hash names', (t) => {
  const root = rootFor(t);
  const old = makeState(root, 'old-0123456789abcdef', 40);
  makeState(root, 'recent-0123456789abcdee', 5);
  makeState(root, 'busy-0123456789abcded', 40, { activeJob: true });
  const current = makeState(root, 'current-0123456789abcdec', 40);
  makeState(root, 'not-a-state-dir', 40);
  const stale = findStaleStates(root, { olderThanMs: 30 * 86400000, exclude: current });
  assert.deepEqual(stale.map((s) => s.dir), [old]);
});

test('findStaleStates: unreadable state root fails closed; unreadable child is excluded', async (t) => {
  const root = rootFor(t);
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot);
  if (process.getuid?.() === 0) {
    t.skip('chmod 000 não restringe leitura quando o teste roda como root');
    return;
  }
  chmodSync(stateRoot, 0o000);
  t.after(() => { if (existsSync(stateRoot)) chmodSync(stateRoot, 0o700); });
  const ctx = { dataDir: root, stateDir: null, stdin: { isTTY: false }, out() {}, err() {} };
  await assert.rejects(run(ctx, []), (err) => err.exitCode === 5 && /Não foi possível ler/.test(err.message));
  chmodSync(stateRoot, 0o700);

  const candidate = makeState(root, 'unreadable-0123456789abcdef', 40);
  const nested = join(candidate, 'jobs');
  chmodSync(nested, 0o000);
  t.after(() => { if (existsSync(nested)) chmodSync(nested, 0o700); });
  const result = findStaleStates(root, { olderThanMs: 1 });
  assert.equal(result.length, 0);
  assert.match(result.skipped[0].reason, /Não foi possível/);
});

test('findStaleStates: malformed server record is excluded with a reason and a live partial record stays live', (t) => {
  const root = rootFor(t);
  const malformed = makeState(root, 'malformed-0123456789abcdef', 40);
  writeFileSync(join(malformed, 'server.json'), '{');
  const partial = makeState(root, 'partial-0123456789abcdee', 40);
  writeFileSync(join(partial, 'server.json'), JSON.stringify({ schemaVersion: 1, pid: 1234, port: 4096, startTime: 'identity' }));
  const old = new Date(Date.now() - 40 * 86400000);
  for (const dir of [malformed, partial]) {
    utimesSync(join(dir, 'server.json'), old, old);
    utimesSync(dir, old, old);
  }
  const stale = findStaleStates(root, {
    olderThanMs: 1,
  }, { identityMatches: (expected, matcher) => expected.pid === 1234 && expected.startTime === 'identity' && matcher(['opencode', 'serve', '--port', '4096']) });
  assert.equal(stale.length, 0, JSON.stringify({ stale, skipped: stale.skipped }));
  assert.match(stale.skipped.find((s) => s.name.startsWith('malformed-')).reason, /JSON/i);
});

test('findStaleStates: excludes a live detached process when the identity matcher confirms it', async (t) => {
  const root = rootFor(t);
  const candidate = makeState(root, 'live-0123456789abcdef', 40);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const identity = getProcessIdentity(child.pid);
  writeFileSync(join(candidate, 'server.json'), JSON.stringify({ schemaVersion: 1, pid: child.pid, port: 4096, startTime: identity.startTime }));
  const old = new Date(Date.now() - 40 * 86400000);
  utimesSync(join(candidate, 'server.json'), old, old);
  utimesSync(candidate, old, old);
  const stale = findStaleStates(root, {
    olderThanMs: 1,
  }, { identityMatches: (expected) => expected.pid === child.pid && expected.startTime === identity.startTime });
  assert.equal(stale.length, 0, JSON.stringify(stale));
});

test('gc rechecks active jobs and directory identity after confirmation before removing', async (t) => {
  const root = rootFor(t);
  const candidate = makeState(root, 'race-0123456789abcdef', 40);
  let stdout = '';
  const ctx = { dataDir: root, stateDir: null, stdin: { isTTY: true }, stderr: {}, out: (v) => { stdout += v; }, err() {} };
  const result = await run(ctx, [], {
    confirm: async () => {
      writeFileSync(join(candidate, 'jobs', 'task-abc-123456.json'), JSON.stringify({ id: 'task-abc-123456', status: 'running' }));
      return true;
    },
  });
  assert.equal(result, 0);
  assert.ok(existsSync(candidate));
  assert.match(stdout, /em uso/);
});

test('gc preserves a replacement directory with a different identity', async (t) => {
  const root = rootFor(t);
  const candidate = makeState(root, 'swap-0123456789abcdef', 40);
  const moved = join(root, 'original-state');
  let stdout = '';
  const ctx = { dataDir: root, stateDir: null, stdin: { isTTY: true }, stderr: {}, out: (v) => { stdout += v; }, err() {} };
  await run(ctx, [], { confirm: async () => {
    renameSync(candidate, moved);
    makeState(root, 'swap-0123456789abcdef', 40);
    return true;
  } });
  assert.ok(existsSync(candidate));
  assert.match(stdout, /Identidade do diretório mudou/);
});

test('cross-UID exclusion cannot be exercised without permission to chown', (t) => {
  t.skip('não há fixture de UID estrangeiro; chown exigiria root ou capability de mudança de proprietário');
});

test('gc skips a candidate if its workspace lock is held', async (t) => {
  const root = rootFor(t);
  const candidate = makeState(root, 'locked-0123456789abcdef', 40);
  const release = tryAcquireLock(join(candidate, 'state.lock'), { purpose: 'test holder' });
  assert.ok(release);
  try {
    let stdout = '';
    const ctx = { dataDir: root, stateDir: null, stdin: { isTTY: true }, stderr: {}, out: (v) => { stdout += v; }, err() {} };
    await run(ctx, [], { confirm: async () => true });
    assert.ok(existsSync(candidate));
    assert.match(stdout, /em uso/);
  } finally {
    release();
  }
});

test('gc rejects invalid --days values with UsageError', async (t) => {
  const root = rootFor(t);
  const ctx = { dataDir: root, stateDir: null, stdin: { isTTY: false }, out() {}, err() {} };
  for (const value of ['0', '-1', '1.5']) {
    await assert.rejects(run(ctx, ['--days', value]), (err) => err.code === 'USAGE' && err.exitCode === 2);
  }
});
