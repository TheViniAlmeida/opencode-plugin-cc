import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  getParentPid, getProcessIdentity, identityMatches, isPidAlive, resolveHookOwner, spawnDetached, terminateProcessGroup,
} from '../../plugins/opc/scripts/lib/process.mjs';
import { deadPid, makeTempDir, removeTempDir, waitFor } from '../helpers.mjs';

const linuxOnly = { skip: process.platform !== 'linux' && 'process groups and /proc are validated on Linux only' };
const IDLE = 'setInterval(() => {}, 1000)';
const IGNORE_TERM = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";

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
  const proc = await spawnDetached(process.execPath, ['-e', `console.log('hello-from-child'); ${IDLE}`], { cwd: dir, env: process.env, logFile });
  t.after(() => killHard(proc.pid));
  assert.ok(proc.pid > 0);
  assert.equal(proc.startTime, getProcessIdentity(proc.pid).startTime);
  const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf8');
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  assert.equal(pgrp, proc.pid);
  await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('hello-from-child'), { message: 'child output in log' });
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test('spawnDetached throws SPAWN_FAILED for a missing binary', async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  await assert.rejects(spawnDetached('definitely-not-a-binary-opc', [], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') }), (err) => {
    assert.equal(err.code, 'SPAWN_FAILED');
    assert.equal(err.exitCode, 5);
    assert.equal(err.details.causeCode, 'ENOENT');
    return true;
  });
});

test('spawnDetached resolves relative executables from the requested cwd', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));
  const proc = await spawnDetached('./bin/node', ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'relative.log') });
  t.after(() => killHard(proc.pid));
  assert.ok(proc.startTime);
  assert.ok(getProcessIdentity(proc.pid));
});

test('spawnDetached accepts either valid outcome for a short-lived child', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  let proc;
  try {
    proc = await spawnDetached('/bin/true', [], { cwd: dir, env: process.env, logFile: path.join(dir, 'exit.log') });
  } catch (err) {
    assert.equal(err.code, 'SPAWN_FAILED');
    assert.equal(err.exitCode, 5);
    assert.match(err.message, /identidade/i);
    return;
  }
  assert.ok(proc.pid > 0 && proc.startTime);
  await waitFor(() => !isPidAlive(proc.pid), { message: 'short-lived child exit' });

});

test('an exited detached child is reported dead (zombie-aware)', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const proc = await spawnDetached(process.execPath, ['-e', ''], { cwd: dir, env: process.env, logFile: path.join(dir, 'l') });
  await waitFor(() => !isPidAlive(proc.pid), { message: 'child exit' });
  assert.equal(getProcessIdentity(proc.pid), null);
});

test('terminateProcessGroup: terminated with SIGTERM, killed when SIGTERM is ignored', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const polite = await spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'a') });
  t.after(() => killHard(polite.pid));
  assert.equal(await terminateProcessGroup(polite, () => true, { graceMs: 2000 }), 'terminated');
  assert.equal(isPidAlive(polite.pid), false);

  const stubborn = await spawnDetached(process.execPath, ['-e', IGNORE_TERM], { cwd: dir, env: process.env, logFile: path.join(dir, 'b') });
  t.after(() => killHard(stubborn.pid));
  await waitFor(() => fs.readFileSync(path.join(dir, 'b'), 'utf8').includes('ready'), { message: 'SIGTERM handler installed' });
  assert.equal(await terminateProcessGroup(stubborn, () => true, { graceMs: 300 }), 'killed');
  assert.equal(isPidAlive(stubborn.pid), false);
});

test('terminateProcessGroup kills same-group descendants when the leader exits on SIGTERM', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
    "child.on('message', () => { process.on('SIGTERM', () => process.exit(0)); console.log('grandchild:' + child.pid); });",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const proc = await spawnDetached(process.execPath, ['-e', script], { cwd: dir, env: process.env, logFile: path.join(dir, 'tree.log') });
  t.after(() => killHard(proc.pid));
  await waitFor(() => fs.readFileSync(path.join(dir, 'tree.log'), 'utf8').match(/grandchild:(\d+)/), { message: 'grandchild pid in log' });
  const grandchildPid = Number(fs.readFileSync(path.join(dir, 'tree.log'), 'utf8').match(/grandchild:(\d+)/)[1]);
  assert.equal(await terminateProcessGroup(proc, () => true, { graceMs: 300 }), 'killed');
  await waitFor(() => !isPidAlive(grandchildPid), { message: 'grandchild exit' });
});

test('terminateProcessGroup never signals a process whose identity does not match', linuxOnly, async (t) => {
  const dir = makeTempDir('opc-proc-');
  t.after(() => removeTempDir(dir));
  const other = await spawnDetached(process.execPath, ['-e', IDLE], { cwd: dir, env: process.env, logFile: path.join(dir, 'c') });
  t.after(() => killHard(other.pid));
  assert.equal(await terminateProcessGroup(other, () => false), 'identity-mismatch');
  assert.equal(await terminateProcessGroup({ pid: other.pid, startTime: 'bogus' }, () => true), 'identity-mismatch');
  assert.equal(isPidAlive(other.pid), true);
  assert.equal(await terminateProcessGroup({ pid: await deadPid(), startTime: '1' }, () => true), 'not-running');
});

for (const mode of ['null', 'throw']) {
  test(`gate 4: identity ${mode} kills the exact child through its handle`, async (t) => {
    const dir = makeTempDir('opc-identity-');
    t.after(() => removeTempDir(dir));
    let pid;
    await assert.rejects(spawnDetached(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {
      cwd: dir, logFile: path.join(dir, 'worker.log'), identityTimeoutMs: 10,
      readIdentity(value) {
        pid = value;
        if (mode === 'throw') throw new Error('identidade indisponível');
        return null;
      },
    }), (err) => err.code === 'SPAWN_FAILED');
    assert.ok(pid > 0);
    assert.equal(isPidAlive(pid), false);
  });
}

test('resolveHookOwner skips a transient shell parent and keeps any other parent', () => {
  const ids = { 10: { pid: 10, startTime: 's10', cmdline: ['/bin/sh', '-c', 'node hook'] }, 7: { pid: 7, startTime: 's7', cmdline: ['claude', '-p'] }, 20: { pid: 20, startTime: 's20', cmdline: ['claude'] } };
  const deps = { identityOf: (pid) => ids[pid] ?? null, parentOf: (pid) => (pid === 10 ? 7 : null) };
  assert.deepEqual(resolveHookOwner(10, deps), { pid: 7, identity: ids[7] });
  assert.deepEqual(resolveHookOwner(20, deps), { pid: 20, identity: ids[20] });
  assert.deepEqual(resolveHookOwner(10, { ...deps, parentOf: () => null }), { pid: 10, identity: ids[10] });
  assert.deepEqual(resolveHookOwner(99, deps), { pid: 99, identity: null });
});

test('getParentPid and resolveHookOwner see through a real `sh -c` parent', linuxOnly, () => {
  assert.equal(getParentPid(process.pid), process.ppid);
  const script = `import { resolveHookOwner } from ${JSON.stringify(new URL('../../plugins/opc/scripts/lib/process.mjs', import.meta.url).href)}; const o = resolveHookOwner(process.ppid); console.log(JSON.stringify({ pid: o.pid, start: o.identity?.startTime }));`;
  // The trailing `; true` keeps sh alive as the parent, as Claude Code's hook runner does.
  const res = spawnSync('sh', ['-c', `"${process.execPath}" --input-type=module -e '${script}'; true`], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const owner = JSON.parse(res.stdout);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.start, getProcessIdentity(process.pid).startTime);
});
