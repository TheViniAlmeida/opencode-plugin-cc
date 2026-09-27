import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireLock, tryAcquireLock, withLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ConnectionError, OpcError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { PLUGIN_ROOT, deadPid, makeTempDir, removeTempDir, runProcess } from '../helpers.mjs';

function tempLock(t) {
  const dir = makeTempDir('opc-lock-');
  t.after(() => removeTempDir(dir));
  return { dir, lock: path.join(dir, 'server.lock') };
}

test('tryAcquireLock creates an O_EXCL file (600) with the owner and release removes it', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'test' });
  assert.equal(typeof release, 'function');
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.purpose, 'test');
  assert.ok(owner.startTime && owner.acquiredAt && owner.token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.equal(tryAcquireLock(lock, { purpose: 'second' }), null);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('acquireLock times out with ConnectionError TIMEOUT naming the holder', async (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'holder' });
  t.after(release);
  await assert.rejects(acquireLock(lock, { timeoutMs: 200, purpose: 'waiter', pollMs: 20 }), (err) => {
    assert.ok(err instanceof ConnectionError);
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /holder/);
    assert.deepEqual(err.details.owner, { pid: process.pid, purpose: 'holder' });
    return true;
  });
});

test('lock publication links a complete private temp file into place', (t) => {
  const { lock } = tempLock(t);
  const originalLink = fs.linkSync;
  let checked = false;
  fs.linkSync = function (tempPath, lockPath) {
    assert.equal(lockPath, lock);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.statSync(tempPath).mode & 0o777, 0o600);
    const owner = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
    assert.deepEqual(Object.keys(owner), ['pid', 'startTime', 'acquiredAt', 'purpose', 'token', 'cancelled']);
    checked = true;
    return originalLink.call(this, tempPath, lockPath);
  };
  t.after(() => { fs.linkSync = originalLink; });

  const release = tryAcquireLock(lock, { purpose: 'atomic' });
  assert.equal(checked, true);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['server.lock']);
  release();
});

test('stale-lock: a lock owned by a dead pid is broken atomically (renamed to *.stale-*)', async (t) => {
  const { dir, lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: '1', acquiredAt: 'x', purpose: 'ghost', token: 'old' }));
  const release = await acquireLock(lock, { timeoutMs: 1000, purpose: 'new' });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'new');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('server.lock.stale-')).length, 1);
  release();
});

test('a lock whose owner pid was reused (start time differs) is broken', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: 'not-my-start-time', purpose: 'reused', token: 't' }));
  const release = await acquireLock(lock, { timeoutMs: 1000, purpose: 'new' });
  release();
});

test('an empty lock younger than five seconds is respected', (t) => {
  const { lock, dir } = tempLock(t);
  fs.writeFileSync(lock, '');
  assert.equal(tryAcquireLock(lock, { purpose: 'x' }), null);
  assert.deepEqual(fs.readdirSync(dir), ['server.lock']);
});

test('an empty lock older than five seconds is renamed stale before replacement', (t) => {
  const { lock, dir } = tempLock(t);
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const release = tryAcquireLock(lock, { purpose: 'x' });
  assert.equal(typeof release, 'function');
  const stale = fs.readdirSync(dir).filter((name) => name.startsWith('server.lock.stale-'));
  assert.equal(stale.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, stale[0]), 'utf8'), '');
  release();
});

test('stale comparison distinguishes different invalid raw bytes and restores the renamed lock', (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, Buffer.from([0xff]));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const originalRename = fs.renameSync;
  let raced = false;
  fs.renameSync = function (source, target) {
    if (source === lock && !raced) {
      fs.writeFileSync(lock, Buffer.from([0xfe]));
      raced = true;
    }
    return originalRename.call(this, source, target);
  };
  t.after(() => { fs.renameSync = originalRename; });

  assert.equal(tryAcquireLock(lock, { purpose: 'new' }), null);
  assert.equal(raced, true);
  assert.deepEqual(fs.readFileSync(lock), Buffer.from([0xfe]));
});

test('stale comparison restores the lock and declines acquisition when either read is unavailable', (t) => {
  const { lock, dir } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, startTime: 'gone', purpose: 'old', token: 'old' }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (String(target) === lock || String(target).startsWith(`${lock}.stale-`)) {
      const err = new Error('simulated unreadable lock');
      err.code = 'EACCES';
      throw err;
    }
    return originalRead.call(this, target, ...args);
  };
  t.after(() => { fs.readFileSync = originalRead; });

  assert.equal(tryAcquireLock(lock, { purpose: 'new' }), null);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('server.lock.stale-')), false);
  fs.readFileSync = originalRead;
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'old');
});

test('temp cleanup failure after publication still returns a working release handle', (t) => {
  const { lock, dir } = tempLock(t);
  const originalUnlink = fs.unlinkSync;
  let tempPath;
  fs.unlinkSync = function (target) {
    if (String(target).startsWith(`${lock}.tmp-`)) {
      tempPath = String(target);
      const err = new Error('simulated temp cleanup failure');
      err.code = 'EACCES';
      throw err;
    }
    return originalUnlink.call(this, target);
  };
  t.after(() => { fs.unlinkSync = originalUnlink; });

  const release = tryAcquireLock(lock, { purpose: 'cleanup' });
  assert.equal(typeof release, 'function');
  assert.equal(fs.existsSync(lock), true);
  release();
  assert.equal(fs.existsSync(lock), false);
  assert.ok(tempPath);
  assert.equal(fs.existsSync(tempPath), true);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('identity unavailable on win32 keeps a live owner lock held', (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: 'different', purpose: 'live', token: 'old' }));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));

  assert.equal(tryAcquireLock(lock, { purpose: 'new' }), null);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'live');
});

test('restore failure throws LOCK_RESTORE_FAILED with exit code 5 and lock path', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: '1', purpose: 'gone', token: 'old' }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  fs.renameSync = function (source, target) {
    if (source === lock) fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: 'racer', purpose: 'racer', token: 'race' }));
    return originalRename.call(this, source, target);
  };
  fs.linkSync = function (source, target) {
    if (source.startsWith(`${lock}.stale-`) && target === lock) {
      const err = new Error('simulated restore failure');
      err.code = 'EACCES';
      throw err;
    }
    return originalLink.call(this, source, target);
  };
  t.after(() => {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
  });

  assert.throws(() => tryAcquireLock(lock, { purpose: 'new' }), (err) => {
    assert.ok(err instanceof OpcError);
    assert.equal(err.code, 'LOCK_RESTORE_FAILED');
    assert.equal(err.exitCode, 5);
    assert.equal(err.details.lock, lock);
    return true;
  });
});

test('release never removes a lock that now belongs to someone else', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'mine' });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: null, purpose: 'theirs', token: 'other' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'theirs');
});

test('release propagates unlink errors and can be retried', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'mine' });
  const originalUnlink = fs.unlinkSync;
  let failOnce = true;
  let failReadOnce = true;
  const originalRead = fs.readFileSync;
  fs.unlinkSync = function (target) {
    if (target === lock && failOnce) {
      failOnce = false;
      const err = new Error('simulated unlink failure');
      err.code = 'EACCES';
      throw err;
    }
    return originalUnlink.call(this, target);
  };
  fs.readFileSync = function (target, ...args) {
    if (target === lock && failReadOnce) {
      failReadOnce = false;
      const err = new Error('simulated read failure');
      err.code = 'EACCES';
      throw err;
    }
    return originalRead.call(this, target, ...args);
  };
  t.after(() => {
    fs.unlinkSync = originalUnlink;
    fs.readFileSync = originalRead;
  });

  assert.throws(release, { code: 'EACCES' });
  assert.equal(fs.existsSync(lock), true);
  assert.throws(release, { code: 'EACCES' });
  assert.equal(fs.existsSync(lock), true);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('withLock releases on success and on failure', async (t) => {
  const { lock } = tempLock(t);
  assert.equal(await withLock(lock, { timeoutMs: 500 }, async () => 42), 42);
  assert.equal(fs.existsSync(lock), false);
  await assert.rejects(withLock(lock, { timeoutMs: 500 }, async () => { throw new Error('inner'); }), /inner/);
  assert.equal(fs.existsSync(lock), false);
});

test('withLock gives mutual exclusion across processes', async (t) => {
  const { dir, lock } = tempLock(t);
  const counter = path.join(dir, 'counter.txt');
  fs.writeFileSync(counter, '0');
  const locksUrl = pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'locks.mjs')).href;
  const script = `
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(locksUrl)};
    await withLock(${JSON.stringify(lock)}, { timeoutMs: 20000, purpose: 'counter', pollMs: 10 }, async () => {
      const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    });
  `;
  const runs = Array.from({ length: 5 }, () => runProcess(process.execPath, ['--input-type=module', '-e', script], { env: process.env }));
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '5');
});

test('orphan recovery is serialized by an identity-owned break lock', async (t) => {
  const { lock } = tempLock(t);
  const orphan = JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' });
  fs.writeFileSync(lock, orphan);
  const releaseBreak = tryAcquireLock(`${lock}.break`, { purpose: 'another-breaker' });
  try {
    assert.equal(tryAcquireLock(lock), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), orphan);
  } finally { releaseBreak(); }
  const release = tryAcquireLock(lock);
  assert.equal(typeof release, 'function');
  release();
});

test('recovery rechecks ownership after acquiring the break lock', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' }));
  const originalLink = fs.linkSync;
  let replacement;
  let releaseNew;
  t.mock.method(fs, 'linkSync', (source, target) => {
    if (target === `${lock}.break` && !replacement) {
      // Another breaker completed before we acquired the recovery guard.
      fs.renameSync(lock, `${lock}.previous`);
      releaseNew = tryAcquireLock(lock, { purpose: 'live-replacement' });
      replacement = fs.readFileSync(lock);
    }
    return originalLink(source, target);
  });
  const release = tryAcquireLock(lock);
  if (release) release();
  try {
    assert.equal(release, null);
    assert.ok(replacement);
    assert.deepEqual(fs.readFileSync(lock), replacement);
  } finally { releaseNew?.(); }
});

test('an orphaned break lock is recoverable without stealing live guards', async (t) => {
  const { lock } = tempLock(t);
  const orphan = JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' });
  fs.writeFileSync(lock, orphan);
  fs.writeFileSync(`${lock}.break`, orphan);
  const releaseGuard = tryAcquireLock(`${lock}.break.break`);
  try { assert.equal(tryAcquireLock(lock), null); } finally { releaseGuard(); }
  const release = tryAcquireLock(lock);
  assert.equal(typeof release, 'function');
  release();
});

test('orphan recovery stress: eight processes repeatedly enter and exit without overlap', async (t) => {
  const { dir, lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' }));
  const markers = path.join(dir, 'markers.jsonl');
  const locksUrl = pathToFileURL(path.join(PLUGIN_ROOT, 'scripts/lib/locks.mjs')).href;
  const script = `
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(locksUrl)};
    for (let i = 0; i < 80; i++) {
      await withLock(${JSON.stringify(lock)}, { timeoutMs: 30000, pollMs: 1 }, async () => {
        fs.appendFileSync(${JSON.stringify(markers)}, JSON.stringify(['enter', process.pid]) + '\\n');
        await new Promise(r => setTimeout(r, 1));
        fs.appendFileSync(${JSON.stringify(markers)}, JSON.stringify(['exit', process.pid]) + '\\n');
      });
    }
  `;
  const results = await Promise.all(Array.from({ length: 8 }, () => runProcess(process.execPath,
    ['--input-type=module', '-e', script], { timeoutMs: 60000 })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const events = fs.readFileSync(markers, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 8 * 80 * 2);
  let holder = null;
  for (const [kind, pid] of events) {
    if (kind === 'enter') { assert.equal(holder, null, `overlap: ${holder} and ${pid}`); holder = pid; }
    else { assert.equal(holder, pid); holder = null; }
  }
  assert.equal(holder, null);
});

test('acquisition cannot enter during orphan rename or release-during-break', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' }));
  const originalRename = fs.renameSync;
  let attempted = false;
  let competing;
  t.mock.method(fs, 'renameSync', (source, target) => {
    const result = originalRename(source, target);
    if (source === lock) {
      attempted = true;
      // Simulates the old owner having released while a breaker held a snapshot.
      competing = tryAcquireLock(lock, { purpose: 'racer' });
    }
    return result;
  });
  let release;
  try {
    release = tryAcquireLock(lock);
    assert.equal(attempted, true);
    assert.equal(competing, null, 'no new holder may enter while recovery is in progress');
    assert.equal(typeof release, 'function');
  } finally { competing?.(); release?.(); }
});

test('a dead break owner is recovered even when the primary lock was already released', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: await deadPid(), startTime: 'gone', token: 'orphan' }));
  const release = tryAcquireLock(lock);
  assert.equal(typeof release, 'function');
  assert.equal(fs.existsSync(`${lock}.break`), false);
  release();
});

test('an unreadable or malformed break owner is not broken by age alone', (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(`${lock}.break`, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${lock}.break`, old, old);
  assert.equal(tryAcquireLock(lock), null);
  assert.equal(fs.readFileSync(`${lock}.break`, 'utf8'), '');
});

test('a recovery guard racing publication withdraws the candidate without unlinking the shared path', (t) => {
  const { lock } = tempLock(t);
  const originalLink = fs.linkSync;
  let releaseBreak;
  t.mock.method(fs, 'linkSync', (source, target) => {
    if (target === lock && !releaseBreak) releaseBreak = tryAcquireLock(`${lock}.break`);
    return originalLink(source, target);
  });
  try {
    assert.equal(tryAcquireLock(lock), null);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).cancelled, 1);
  } finally { releaseBreak?.(); }
  const release = tryAcquireLock(lock);
  assert.equal(typeof release, 'function', 'withdrawn candidates are recoverable even while their process lives');
  release();
});

test('withdrawal changes only the candidate inode after a breaker replaced the path', (t) => {
  const { lock } = tempLock(t);
  const originalLink = fs.linkSync;
  const moved = `${lock}.stale-candidate`;
  let replaced = false;
  let replacement;
  t.mock.method(fs, 'linkSync', (source, target) => {
    const result = originalLink(source, target);
    if (target === lock && !replaced) {
      replaced = true;
      fs.renameSync(lock, moved);
      // A breaker published its replacement before the candidate validated itself.
      replacement = JSON.parse(fs.readFileSync(moved, 'utf8'));
      replacement.token = 'replacement';
      fs.writeFileSync(lock, JSON.stringify(replacement));
    }
    return result;
  });
  assert.equal(tryAcquireLock(lock), null);
  assert.equal(JSON.parse(fs.readFileSync(moved, 'utf8')).cancelled, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), replacement);
});
