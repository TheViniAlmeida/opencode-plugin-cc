import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getProcessIdentity, identityMatches, isPidAlive, spawnDetached, terminateProcessGroup,
} from '../../plugins/opc/scripts/lib/process.mjs';
import { deadPid, makeTempDir, removeTempDir, waitFor } from '../helpers.mjs';

const linuxOnly = { skip: process.platform !== 'linux' && 'process groups and /proc are validated on Linux only' };
const IDLE = 'setInterval(() => {}, 1000)';
const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

function killHard(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

test('isPidAlive is true for this process and false for a dead or invalid pid', async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(await deadPid()), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test('getProcessIdentity returns start time and cmdline; null for dead pids', async () => {
  const me = getProcessIdentity(process.pid);
  assert.equal(me.pid, process.pid);
  assert.ok(me.startTime && String(me.startTime).length > 0);
  assert.ok(me.cmdline.some((a) => a.includes('node')));
  assert.equal(getProcessIdentity(await deadPid()), null);
});

test('identityMatches checks start time and the cmdline matcher', () => {
  const me = getProcessIdentity(process.pid);
  assert.equal(identityMatches({ pid: process.pid, startTime: me.startTime }, () => true), true);
  assert.equal(identityMatches({ pid: process.pid, startTime: 'other' }, () => true), false);
  assert.equal(identityMatches({ pid: process.pid, startTime: me.startTime }, () => false), false);
});

test('spawnDetached starts a group leader writing to the log file (mode 600)', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const logFile = path.join(dir, 'out.log');
  const proc = spawnDetached(process.execPath, ['-e', `console.log('hello-from-child'); ${IDLE}`], { cwd: dir, env: process.env, logFile });
  t.after(() => killHard(proc.pid));
  assert.ok(proc.pid > 0);
  assert.equal(proc.startTime, getProcessIdentity(proc.pid).startTime);
  const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf8');
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  assert.equal(pgrp, proc.pid);
  await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('hello-from-child'), { message: 'child output in log' });
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test('spawnDetached throws ENOENT for a missing binary', (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  assert.throws(() => spawnDetached('definitely-not-a-binary-opc', [], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') }), { code: 'ENOENT' });
});

test('an exited detached child is reported dead (zombie-aware)', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const proc = spawnDetached(process.execPath, ['-e', ''], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') });
  await waitFor(() => !isPidAlive(proc.pid), { message: 'child exit' });
  assert.equal(getProcessIdentity(proc.pid), null);
});

test('terminateProcessGroup: terminated with SIGTERM, killed when SIGTERM is ignored', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const polite = spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'a') });
  t.after(() => killHard(polite.pid));
  assert.equal(await terminateProcessGroup(polite, () => true, { graceMs: 2000 }), 'terminated');
  assert.equal(isPidAlive(polite.pid), false);

  const stubborn = spawnDetached(process.execPath, ['-e', IGNORE_TERM], { cwd: dir, env: process.env, logFile: path.join(dir, 'b') });
  t.after(() => killHard(stubborn.pid));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await terminateProcessGroup(stubborn, () => true, { graceMs: 300 }), 'killed');
  assert.equal(isPidAlive(stubborn.pid), false);
});

test('terminateProcessGroup never signals a process whose identity does not match', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const other = spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'c') });
  t.after(() => killHard(other.pid));
  assert.equal(await terminateProcessGroup(other, () => false), 'identity-mismatch');
  assert.equal(await terminateProcessGroup({ pid: other.pid, startTime: 'bogus' }, () => true), 'identity-mismatch');
  assert.equal(isPidAlive(other.pid), true);
  assert.equal(await terminateProcessGroup({ pid: await deadPid(), startTime: '1' }, () => true), 'not-running');
});
