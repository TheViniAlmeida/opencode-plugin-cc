// File locks with O_EXCL, verifiable owner and atomic breaking of orphan locks (spec §5.6).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConnectionError } from './opc-error.mjs';
import { getProcessIdentity, isPidAlive } from './process.mjs';

const FRESH_UNREADABLE_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readOwner(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { raw: null, owner: null };
  }
  try {
    return { raw, owner: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { raw, owner: null };
  }
}

function ownerAlive(lockPath, info) {
  if (info.missing) return false;
  if (!info.owner || !Number.isInteger(info.owner.pid)) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < FRESH_UNREADABLE_MS;
    } catch {
      return false;
    }
  }
  if (info.owner.cancelled === 1) return false;
  if (process.platform === 'win32') return isPidAlive(info.owner.pid);
  const identity = getProcessIdentity(info.owner.pid);
  if (!identity) return isPidAlive(info.owner.pid);
  return String(identity.startTime) === String(info.owner.startTime);
}

function createLockFile(lockPath, purpose) {
  const me = getProcessIdentity(process.pid);
  const token = randomUUID();
  const body = JSON.stringify({
    pid: process.pid,
    startTime: me ? me.startTime : null,
    acquiredAt: new Date().toISOString(),
    purpose: purpose ?? null,
    token,
    cancelled: 0,
  });
  const tempPath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(tempPath, 'wx+', 0o600);
  try {
    fs.writeFileSync(fd, body);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  try {
    fs.linkSync(tempPath, lockPath);
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    throw err;
  }
  let tempCleaned = false;
  try {
    fs.unlinkSync(tempPath);
    tempCleaned = true;
  } catch (err) {
    if (err.code === 'ENOENT') tempCleaned = true;
  }
  const content = Buffer.from(body);
  let released = false;
  function release() {
    if (released) return;
    let current;
    try {
      current = fs.readFileSync(lockPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        released = true;
        return;
      }
      throw err;
    }
    if (!current.equals(content)) {
      released = true;
      return;
    }
    try {
      fs.unlinkSync(lockPath);
      released = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        released = true;
        return;
      }
      throw err;
    }
    if (!tempCleaned) {
      try {
        fs.unlinkSync(tempPath);
        tempCleaned = true;
      } catch (err) {
        if (err.code === 'ENOENT') tempCleaned = true;
      }
    }
  }
  return {
    release,
    content,
    close: () => fs.closeSync(fd),
    // Withdraw only this inode, even if recovery already renamed it. Unlinking
    // the shared path here races with a breaker replacing our candidate.
    cancel: () => fs.writeSync(fd, Buffer.from('1'), 0, 1, content.length - 2),
  };
}

function publishLock(lockPath, purpose, holdingBreak = false) {
  if (!holdingBreak && fs.existsSync(`${lockPath}.break`)) return null;
  const candidate = createLockFile(lockPath, purpose);
  try {
    // Check AFTER publication: a pre-check alone races with creation of .break.
    // Recovery may have renamed this candidate before dropping its guard, so also
    // verify ownership after checking the guard. No caller enters until both pass.
    const guarded = !holdingBreak && fs.existsSync(`${lockPath}.break`);
    const current = readOwner(lockPath);
    if (guarded || !Buffer.isBuffer(current.raw) || !current.raw.equals(candidate.content)) {
      candidate.cancel();
      return null;
    }
    return candidate.release;
  } finally {
    candidate.close();
  }
}

function breakStaleLock(lockPath, judged) {
  const stale = `${lockPath}.stale-${Date.now()}-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, stale);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const moved = readOwner(stale);
  const sameLock = Buffer.isBuffer(moved.raw)
    && Buffer.isBuffer(judged.raw)
    && moved.raw.equals(judged.raw);
  if (!sameLock) {
    // A racing publication is still a candidate: its guard check prevents entry.
    // Restore under the guard; withdrawn candidates remain recoverable.
    try {
      fs.linkSync(stale, lockPath);
      fs.unlinkSync(stale);
    } catch (err) {
      throw new ConnectionError('LOCK_RESTORE_FAILED', `Não foi possível restaurar o lock ${lockPath}.`, {
        details: { lock: lockPath },
      });
    }
  }
}

function tryAcquire(lockPath, purpose, recoveryGuard = false) {
  try {
    const release = publishLock(lockPath, purpose);
    if (release) return release;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const canBreak = (info) => !info.missing && Buffer.isBuffer(info.raw)
    // Recovery guards require an identified dead owner (or explicit withdrawal), never an expired mtime.
    && (!recoveryGuard || (Number.isInteger(info.owner?.pid) && info.owner.pid > 0 && info.owner.startTime != null))
    && !ownerAlive(lockPath, info);
  const initial = readOwner(lockPath);
  if (!initial.missing && !canBreak(initial)) return null;

  // The same protocol protects orphaned recovery guards: concurrent reapers of a
  // dead .break owner serialize on .break.break and re-read that owner there.
  const releaseBreak = tryAcquire(`${lockPath}.break`, 'recover-lock', true);
  if (!releaseBreak) return null;
  try {
    const current = readOwner(lockPath);
    // A live owner may release and exit during the identity check. Acquirers
    // cannot enter while this guard exists; missing means create, never rename.
    // Re-read here so a newer live owner is never judged using an old snapshot.
    if (!current.missing) {
      if (!canBreak(current)) return null;
      breakStaleLock(lockPath, current);
    }
    try {
      return publishLock(lockPath, purpose, true);
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw err;
    }
  } finally {
    releaseBreak();
  }
}

export function tryAcquireLock(lockPath, { purpose } = {}) {
  return tryAcquire(lockPath, purpose);
}

export async function acquireLock(lockPath, { timeoutMs, purpose, pollMs = 100 } = {}) {
  const deadline = performance.now() + (timeoutMs ?? 0);
  for (;;) {
    const release = tryAcquireLock(lockPath, { purpose });
    if (release) return release;
    if (performance.now() >= deadline) {
      const { owner } = readOwner(lockPath);
      const holder = owner ? ` (dono: pid ${owner.pid}, ${owner.purpose ?? 'sem propósito'})` : '';
      throw new ConnectionError('TIMEOUT', `Tempo esgotado esperando o lock ${path.basename(lockPath)}${holder}.`, {
        details: { lock: path.basename(lockPath), owner: owner ? { pid: owner.pid, purpose: owner.purpose } : null },
      });
    }
    await sleep(pollMs);
  }
}

export async function withLock(lockPath, opts, fn) {
  const release = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
