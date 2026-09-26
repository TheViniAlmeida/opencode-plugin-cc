// Process identity (cmdline + start time), detached spawn and group termination (spec §5.1.3, §5.5).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).split(' ');
    // fields[0] = state (field 3), fields[19] = starttime (field 22)
    return { state: fields[0], startTime: fields[19] };
  } catch {
    return null;
  }
}

function psField(pid, field) {
  const res = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out === '' ? null : out;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (process.platform === 'linux') {
    const stat = readProcStat(pid);
    return Boolean(stat) && stat.state !== 'Z';
  }
  if (process.platform === 'win32') return true;
  const state = psField(pid, 'stat');
  return Boolean(state) && !state.startsWith('Z');
}

export function getProcessIdentity(pid) {
  if (!isPidAlive(pid)) return null;
  if (process.platform === 'linux') {
    const stat = readProcStat(pid);
    if (!stat) return null;
    let cmdline = [];
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s.length > 0);
    } catch {
      return null;
    }
    return { pid, startTime: stat.startTime, cmdline };
  }
  if (process.platform === 'win32') return null;
  const startTime = psField(pid, 'lstart');
  const command = psField(pid, 'command');
  if (!startTime || !command) return null;
  return { pid, startTime, cmdline: command.split(/\s+/) };
}

export function identityMatches(expected, matcher) {
  if (!expected || !Number.isInteger(expected.pid)) return false;
  const current = getProcessIdentity(expected.pid);
  if (!current) return false;
  if (String(current.startTime) !== String(expected.startTime)) return false;
  return Boolean(matcher(current.cmdline));
}

function assertCommandExists(command, env) {
  const paths = command.includes(path.sep) ? [command] : (env.PATH || '').split(path.delimiter).map((entry) => path.join(entry || '.', command));
  if (!paths.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  })) {
    const err = new Error(`spawn ${command} ENOENT`);
    err.code = 'ENOENT';
    throw err;
  }
}

export function spawnDetached(command, args, { cwd, env, logFile }) {
  assertCommandExists(command, env);
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('error', () => {});
    if (!child.pid) {
      const err = new Error(`failed to spawn ${command}`);
      err.code = 'ENOENT';
      throw err;
    }
    child.unref();
    let identity = getProcessIdentity(child.pid);
    for (let attempt = 0; !identity && attempt < 20; attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      identity = getProcessIdentity(child.pid);
    }
    return { pid: child.pid, startTime: identity ? identity.startTime : null };
  } finally {
    fs.closeSync(fd);
  }
}

function signalGroup(pid, signal) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

function check(expected, matcher) {
  const current = getProcessIdentity(expected.pid);
  if (!current) return 'gone';
  if (String(current.startTime) !== String(expected.startTime) || !matcher(current.cmdline)) return 'mismatch';
  return 'ok';
}

async function waitGone(expected, matcher, ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    await sleep(100);
    if (check(expected, matcher) !== 'ok') return true;
  }
  return check(expected, matcher) !== 'ok';
}

export async function terminateProcessGroup(expected, matcher, { graceMs = 3000 } = {}) {
  const first = check(expected, matcher);
  if (first === 'gone') return 'not-running';
  if (first === 'mismatch') return 'identity-mismatch';
  signalGroup(expected.pid, 'SIGTERM');
  if (await waitGone(expected, matcher, graceMs)) return 'terminated';
  if (check(expected, matcher) !== 'ok') return 'terminated';
  signalGroup(expected.pid, 'SIGKILL');
  await waitGone(expected, matcher, 2000);
  return 'killed';
}
