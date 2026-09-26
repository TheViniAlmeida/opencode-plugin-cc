// File locks with O_EXCL, verifiable owner and atomic breaking of orphan locks (spec §5.6).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConnectionError } from './opc-error.mjs';
import { getProcessIdentity } from './process.mjs';

const FRESH_UNREADABLE_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return { raw, owner: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { raw: null, owner: null };
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
  const identity = getProcessIdentity(info.owner.pid);
  if (!identity) return false;
  if (info.owner.startTime === null || info.owner.startTime === undefined) return true;
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
  });
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const info = readOwner(lockPath);
    if (info.owner && info.owner.token === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  };
}

function breakStaleLock(lockPath, judged) {
  const stale = `${lockPath}.stale-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(lockPath, stale);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const moved = readOwner(stale);
  const sameLock = (moved.raw ?? null) === (judged.raw ?? null);
  if (!sameLock) {
    // We moved a fresh lock taken by someone else between our check and the rename: put it back.
    try {
      fs.linkSync(stale, lockPath);
      fs.unlinkSync(stale);
    } catch {
      // A third process already holds lockPath; the stale copy stays for inspection.
    }
  }
}

export function tryAcquireLock(lockPath, { purpose } = {}) {
  try {
    return createLockFile(lockPath, purpose);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const info = readOwner(lockPath);
  if (ownerAlive(lockPath, info)) return null;
  breakStaleLock(lockPath, info);
  try {
    return createLockFile(lockPath, purpose);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
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
