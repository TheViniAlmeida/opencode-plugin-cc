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
  if (process.platform === 'win32') return isPidAlive(info.owner.pid);
  const identity = getProcessIdentity(info.owner.pid);
  if (!identity) return false;
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
  const tempPath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tempPath, lockPath);
  } catch (err) {
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
  return function release() {
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
  };
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
    // We moved a fresh lock taken by someone else between our check and the rename: put it back.
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
