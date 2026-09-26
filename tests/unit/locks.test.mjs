import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { acquireLock, tryAcquireLock, withLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
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
    return true;
  });
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

test('a fresh unreadable lock is respected; an old unreadable one is broken', async (t) => {
  const { lock } = tempLock(t);
  fs.writeFileSync(lock, '');
  assert.equal(tryAcquireLock(lock, { purpose: 'x' }), null);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const release = tryAcquireLock(lock, { purpose: 'x' });
  assert.equal(typeof release, 'function');
  release();
});

test('release never removes a lock that now belongs to someone else', (t) => {
  const { lock } = tempLock(t);
  const release = tryAcquireLock(lock, { purpose: 'mine' });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: null, purpose: 'theirs', token: 'other' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).purpose, 'theirs');
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
