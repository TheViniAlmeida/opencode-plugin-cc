// Process identity (cmdline + start time), detached spawn and group termination (spec §5.1.3, §5.5).
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, OpcError } from './opc-error.mjs';

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

function assertCommandExists(command, env, cwd) {
  const hasPath = command.includes('/') || command.includes(path.sep);
  const paths = hasPath
    ? [path.resolve(cwd, command)]
    : (env.PATH || '').split(path.delimiter).map((entry) => path.resolve(cwd, entry || '.', command));
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

function spawnFailed(message, err = undefined) {
  return new OpcError('SPAWN_FAILED', message, {
    exitCode: ExitCode.CONNECTION,
    details: err ? { causeCode: err.code } : undefined,
    cause: err,
  });
}

export async function spawnDetached(command, args, { cwd = process.cwd(), env = process.env, logFile, readIdentity = getProcessIdentity, identityTimeoutMs = 1000 }) {
  try {
    assertCommandExists(command, env, cwd);
  } catch (err) {
    throw spawnFailed(`Não foi possível iniciar o processo: ${command}`, err);
  }
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    try {
      await once(child, 'spawn');
    } catch (err) {
      throw spawnFailed(`Não foi possível iniciar o processo: ${command}`, err);
    }
    if (!child.pid) {
      throw spawnFailed(`Não foi possível iniciar o processo: ${command}`);
    }
    let identity;
    try {
      identity = readIdentity(child.pid);
      const deadline = performance.now() + identityTimeoutMs;
      while (!identity && performance.now() < deadline) {
        await sleep(25);
        identity = readIdentity(child.pid);
      }
      if (!identity) throw new Error('Identidade do processo indisponível');
    } catch (err) {
      // Retain ownership until verification; never signal an unverified PID/group.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      throw spawnFailed(`Não foi possível ler a identidade do processo iniciado: ${command}`, err);
    }
    child.unref();
    return { pid: child.pid, startTime: identity.startTime };
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
      if (err.code === 'ESRCH') return;
      throw err;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

function isProcessGroupAlive(pgid) {
  if (process.platform === 'win32') return isPidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    throw err;
  }
}

function check(expected, matcher) {
  const current = getProcessIdentity(expected.pid);
  if (!current) return 'gone';
  if (String(current.startTime) !== String(expected.startTime) || !matcher(current.cmdline)) return 'mismatch';
  return 'ok';
}

async function waitGroupGone(pgid, ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    await sleep(100);
  }
  return !isProcessGroupAlive(pgid);
}

function killUnconfirmed(pgid) {
  return new OpcError('KILL_UNCONFIRMED', `O grupo de processos ${pgid} continuou ativo após SIGKILL`, {
    exitCode: ExitCode.JOB_FAILED,
  });
}

// While a process exits the kernel drops its memory (empty /proc/<pid>/cmdline) before it becomes a
// zombie: an empty cmdline with the expected start time is our process on its way out, not a stranger.
export async function exitingWithoutCmdline(expected, waitMs = 1000) {
  const current = getProcessIdentity(expected.pid);
  if (!current || current.cmdline.length > 0 || String(current.startTime) !== String(expected.startTime)) return false;
  const deadline = performance.now() + waitMs;
  while (performance.now() < deadline) {
    if (!isPidAlive(expected.pid)) return true;
    await sleep(50);
  }
  return !isPidAlive(expected.pid);
}

export async function terminateProcessGroup(expected, matcher, { graceMs = 3000 } = {}) {
  let first = check(expected, matcher);
  if (first === 'mismatch' && await exitingWithoutCmdline(expected)) first = 'gone';
  if (first === 'gone') return 'not-running';
  if (first === 'mismatch') return 'identity-mismatch';
  signalGroup(expected.pid, 'SIGTERM');
  if (await waitGroupGone(expected.pid, graceMs)) return 'terminated';
  const beforeKill = check(expected, matcher);
  if (beforeKill === 'mismatch') throw killUnconfirmed(expected.pid);
  if (!isProcessGroupAlive(expected.pid)) return 'terminated';
  // A dead leader's PID cannot be recycled as this PGID while any member of the group remains.
  signalGroup(expected.pid, 'SIGKILL');
  if (!await waitGroupGone(expected.pid, 2000)) throw killUnconfirmed(expected.pid);
  return 'killed';
}
