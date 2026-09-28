#!/usr/bin/env node
// Read-only probe for the SessionStart parent process ancestry (§15 item 9).
// Run while Claude Code is open: node tests/live/probe-hook-ppid.mjs <workspace>
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { redactText } from '../../plugins/opc/scripts/lib/redact.mjs';
import { resolveDataDir, resolveWorkspaceRoot, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';

const workspace = process.argv[2] ?? process.cwd();
const stateDir = workspaceStateDir(resolveDataDir(process.env), resolveWorkspaceRoot(workspace));

function readParentPid(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number(result.stdout.trim());
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

function describe(pid) {
  const identity = getProcessIdentity(pid);
  if (!identity) return null;
  let comm = null;
  if (process.platform === 'linux') {
    try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* process may have exited */ }
  }
  if (!comm) {
    const result = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
    comm = result.stdout.trim() || null;
  }
  return {
    pid,
    ppid: readParentPid(pid),
    startTime: identity.startTime,
    comm,
    args: identity.cmdline.map((arg) => redactText(arg)),
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(`${stateDir}/state.json`, 'utf8'));
} catch {
  state = null;
}

const sessionPids = Array.isArray(state?.claudeSessions)
  ? state.claudeSessions.map((entry) => entry?.pid).filter((pid) => Number.isInteger(pid) && pid > 1)
  : [];
const seen = new Set();
for (const sessionPid of sessionPids) {
  let pid = sessionPid;
  for (let depth = 0; pid && pid > 1 && depth < 8 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const processInfo = describe(pid);
    if (!processInfo) break;
    console.log(JSON.stringify(processInfo));
    pid = processInfo.ppid;
  }
}
