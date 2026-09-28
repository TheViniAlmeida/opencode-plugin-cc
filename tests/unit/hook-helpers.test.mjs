import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

import { makeTempDir, PLUGIN_ROOT, trackTempDir } from '../helpers.mjs';
import { DELEGATION_REMINDER, writeEnvExports } from '../../plugins/opc/scripts/commands/hook-session-start.mjs';
import { run as runReaper, KEEP_SERVER_REASONS, decideServerFate } from '../../plugins/opc/scripts/commands/reap.mjs';
import { run as runSessionEnd } from '../../plugins/opc/scripts/commands/hook-session-end.mjs';
import { createJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

test('writeEnvExports appends shell-safe exports and skips empty values', (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-envfile-'));
  const file = path.join(dir, 'claude.env');
  assert.equal(writeEnvExports(file, { A: "it's", B: '', C: null, D: '/p a/t$h' }), 2);
  assert.equal(fs.readFileSync(file, 'utf8'), "export A='it'\"'\"'s'\nexport D='/p a/t$h'\n");
  const sourced = spawnSync('sh', ['-c', `. "${file}"; printf '%s|%s' "$A" "$D"`], { encoding: 'utf8' });
  assert.equal(sourced.stdout, "it's|/p a/t$h");
  assert.equal(writeEnvExports('', { A: 'x' }), 0);
});

test('decideServerFate keeps the server unless nothing needs it', () => {
  const record = { spawnedBy: 'opc' };
  assert.equal(decideServerFate({ record }), 'stop');
  assert.equal(decideServerFate({ record, attached: true }), 'keep:attached');
  assert.equal(decideServerFate({ record: null }), 'keep:no-server');
  assert.equal(decideServerFate({ record: { spawnedBy: 'someone-else' } }), 'keep:not-plugin-spawned');
  assert.equal(decideServerFate({ record, liveSessions: [{ sessionId: 's2' }] }), 'keep:live-sessions');
  assert.equal(decideServerFate({ record, activeJobs: [{ id: 'review-1' }] }), 'keep:active-jobs');
  assert.deepEqual([...KEEP_SERVER_REASONS].sort(), ['clear', 'resume']);
});

test('the delegation reminder points to the read-only delegation commands', () => {
  assert.match(DELEGATION_REMINDER, /\/opc:ask/);
  assert.match(DELEGATION_REMINDER, /\/opc:plan/);
  assert.match(DELEGATION_REMINDER, /Nunca encadeie delegações/);
  assert.ok(DELEGATION_REMINDER.length < 10000, 'additionalContext está limitado a 10.000 caracteres');
});

test('hooks.json registers the three hooks through the companion', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const command = (event) => hooks[event][0].hooks[0];
  assert.match(command('SessionStart').command, /opc-companion\.mjs" hook-session-start$/);
  assert.match(command('SessionEnd').command, /opc-companion\.mjs" hook-session-end$/);
  assert.match(command('Stop').command, /opc-companion\.mjs" hook-stop$/);
  assert.equal(command('Stop').timeout, 900);
  for (const event of ['SessionStart', 'SessionEnd', 'Stop']) {
    assert.equal(command(event).type, 'command');
    assert.match(command(event).command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/opc-companion\.mjs" /);
  }
  for (const sub of ['hook-session-start', 'hook-session-end', 'hook-stop', 'reap']) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'commands', `${sub}.mjs`)), `${sub}.mjs existe`);
  }
});

test('reaper logs individual cancel outcomes and keeps server when one cancellation fails', async (t) => {
  const root = trackTempDir(t, makeTempDir('opc-reaper-cancel-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx = {
    cwd: root, workspaceRoot: root, stateDir, dataDir: root, env: { OPC_REAP_GRACE_MS: '0' },
    config: { server: { bootTimeoutSec: 1 } },
    output: '',
    out(value) { this.output += value; },
  };
  const okJob = await createJob(stateDir, { kind: 'task', title: 'cancel ok', workspaceRoot: root, claudeSessionId: 'ending' });
  const failedJob = await createJob(stateDir, { kind: 'task', title: 'cancel failed', workspaceRoot: root, claudeSessionId: 'ending' });
  let stopCalled = false;
  const result = await runReaper(ctx, ['--session', 'ending', '--reason', 'other'], {
    cancelJobFn: async (_ctx, id) => {
      if (id === okJob.id) {
        await updateJob(stateDir, id, { status: 'cancelled', phase: 'cancelled', completedAt: new Date().toISOString() });
        return { ok: true };
      }
      return { ok: false, code: 'CANCEL_FAILED' };
    },
    readServerRecordFn: () => ({ spawnedBy: 'opc' }),
    stopServerFn: async () => { stopCalled = true; return { stopped: true }; },
  });
  assert.equal(result, 0);
  const events = ctx.output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === 'cancelled' && event.jobId === okJob.id));
  assert.ok(events.some((event) => event.event === 'cancel_failed' && event.jobId === failedJob.id && event.code === 'CANCEL_FAILED'));
  assert.ok(events.some((event) => event.event === 'decision' && event.decision === 'keep:active-jobs'));
  assert.equal(stopCalled, false);
});

test('reaper keeps the server when a cancel fails for a job no longer counted as live', async (t) => {
  const root = trackTempDir(t, makeTempDir('opc-reaper-lost-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx = {
    cwd: root, workspaceRoot: root, stateDir, dataDir: root, env: { OPC_REAP_GRACE_MS: '0' },
    config: { server: { bootTimeoutSec: 1 } },
    output: '',
    out(value) { this.output += value; },
  };
  const lost = await createJob(stateDir, { kind: 'task', title: 'worker lost', workspaceRoot: root, claudeSessionId: 'ending' });
  let stopCalled = false;
  await runReaper(ctx, ['--session', 'ending', '--reason', 'other'], {
    // The record leaves the live set (worker lost) but the abort of its session was not confirmed.
    cancelJobFn: async (_ctx, id) => {
      await updateJob(stateDir, id, { status: 'failed', phase: 'failed', errorCode: 'WORKER_LOST', completedAt: new Date().toISOString() });
      return { ok: false, code: 'CANCEL_FAILED' };
    },
    readServerRecordFn: () => ({ spawnedBy: 'opc' }),
    stopServerFn: async () => { stopCalled = true; return { stopped: true }; },
  });
  const events = ctx.output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === 'cancel_failed' && event.jobId === lost.id));
  assert.ok(events.some((event) => event.event === 'decision' && event.decision === 'keep:active-jobs'));
  assert.equal(stopCalled, false);
});

test('SessionEnd logs a redacted diagnostic when spawning the reaper rejects', async (t) => {
  const root = trackTempDir(t, makeTempDir('opc-session-end-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx = {
    cwd: root, workspaceRoot: root, stateDir, dataDir: root, env: { OPC_DATA_DIR: root },
    stdin: Readable.from([JSON.stringify({ cwd: root, session_id: 'spawn-reject', reason: 'other' })]),
    out() {}, err() { assert.fail('hook must not emit stderr on spawn failure'); },
  };
  const started = performance.now();
  const privateCode = 'PRIVATE_SPAWN_CODE_456';
  registerSecret(privateCode);
  const code = await runSessionEnd(ctx, [], { spawnDetachedFn: async () => { const err = new Error('spawn rejected'); err.code = privateCode; throw err; } });
  assert.equal(code, 0);
  assert.ok(performance.now() - started < 1000);
  const log = fs.readFileSync(path.join(stateDir, 'reaper.log'), 'utf8');
  const diagnostic = JSON.parse(log.trim().split('\n').at(-1));
  assert.equal(diagnostic.event, 'spawn_failed');
  assert.equal(diagnostic.code, '***');
  assert.equal(diagnostic.message, 'spawn rejected');
});
