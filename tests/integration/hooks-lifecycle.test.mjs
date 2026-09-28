import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { registerStopper, runCli, testEnv } from '../helpers.mjs';
import { fixtureModelIds, hookInput, makeMainRepo, readJsonLines, serverAlive, stateDirFor, waitFor, writeFile, writeGlobalConfig } from '../f2b-helpers.mjs';
import { acquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { listJobs, readJob, serverLockPath } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { loadState } from '../../plugins/opc/scripts/lib/state.mjs';
import { isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { readServerRecord, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';

function setup(t, { scenario = 'ok', extra = {}, config = {} } = {}) {
  const cwd = makeMainRepo(t), env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, { defaultModel: fixtureModelIds()[0], ...config });
  return { cwd, env, stateDir: stateDirFor(env, cwd) };
}
function hook(env, cwd, sub, fields) { return runCli([sub], { env, cwd, stdin: hookInput(cwd, fields) }); }
async function startServer(env, cwd) { const result = await runCli(['setup', '--json'], { env, cwd }); assert.equal(result.code, 0, result.stderr); }
function reaperDecision(stateDir, sessionId, timeoutMs = 20000) {
  return waitFor(() => readJsonLines(path.join(stateDir, 'reaper.log')).find((line) => line.event === 'decision' && line.sessionId === sessionId), { timeoutMs, message: `reaper decision for ${sessionId}` });
}

test('SessionStart exports variables and registers Claude session', async (t) => {
  const { cwd, env, stateDir } = setup(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-envfile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'claude.env');
  const result = await runCli(['hook-session-start'], { env: { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: env.OPC_DATA_DIR }, cwd, stdin: hookInput(cwd, { session_id: 'sess-start', source: 'startup', transcript_path: '/tmp/t.jsonl', hook_event_name: 'SessionStart' }) });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, '');
  const exported = fs.readFileSync(envFile, 'utf8');
  assert.match(exported, /^export OPC_COMPANION_SESSION_ID='sess-start'$/m);
  assert.match(exported, /^export OPC_COMPANION_TRANSCRIPT_PATH='\/tmp\/t\.jsonl'$/m);
  assert.match(exported, /^export OPC_DATA_DIR='.+'$/m); assert.match(exported, /^export CLAUDE_PLUGIN_DATA='.+'$/m);
  const [entry] = loadState(stateDir).claudeSessions;
  assert.equal(entry.sessionId, 'sess-start'); assert.equal(entry.source, 'startup'); assert.ok(Number.isInteger(entry.pid) && entry.pid > 0); assert.equal(typeof entry.pidStartTime, 'string');
});

test('SessionStart injects context only when delegation.auto is enabled', async (t) => {
  const { cwd, env } = setup(t, { config: { delegation: { auto: true } } });
  const result = await hook(env, cwd, 'hook-session-start', { session_id: 'sess-delegation', source: 'startup' });
  assert.equal(result.code, 0, result.stderr); const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart'); assert.match(payload.hookSpecificOutput.additionalContext, /\/opc:ask/);
});

test('hooks tolerate empty or invalid stdin and missing cwd', async (t) => {
  const { cwd, env } = setup(t);
  for (const sub of ['hook-session-start', 'hook-session-end', 'hook-stop']) for (const stdin of ['', '{oops', hookInput('/nonexistent/opc/dir', { session_id: 'ghost', reason: 'other' })]) {
    const result = await runCli([sub], { env, cwd, stdin }); assert.equal(result.code, 0, `${sub}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /\n\s+at .+:\d+:\d+/); if (sub !== 'hook-stop') assert.equal(result.stdout, '');
  }
});

test('SessionEnd exits under 1s and spawns reaper', async (t) => {
  const { cwd, env, stateDir } = setup(t); await hook(env, cwd, 'hook-session-start', { session_id: 'fast-end' });
  const started = performance.now(), result = await hook(env, cwd, 'hook-session-end', { session_id: 'fast-end', reason: 'clear', hook_event_name: 'SessionEnd' });
  assert.equal(result.code, 0, result.stderr); assert.ok(performance.now() - started < 1000);
  assert.equal((await reaperDecision(stateDir, 'fast-end')).decision, 'keep:reason-clear');
  assert.equal(loadState(stateDir).claudeSessions.some((entry) => entry.sessionId === 'fast-end'), false);
  assert.ok(readJsonLines(path.join(stateDir, 'sessions.log')).some((line) => line.event === 'end' && line.sessionId === 'fast-end' && line.reason === 'clear'));
  assert.equal(fs.statSync(path.join(stateDir, 'reaper.log')).mode & 0o777, 0o600);
});

test('reaper keeps server on clear and resume', async (t) => {
  const { cwd, env, stateDir } = setup(t, { extra: { OPC_REAP_GRACE_MS: '200' } }); await startServer(env, cwd);
  for (const reason of ['clear', 'resume']) { const id = `keep-${reason}`; await hook(env, cwd, 'hook-session-start', { session_id: id }); await hook(env, cwd, 'hook-session-end', { session_id: id, reason }); assert.equal((await reaperDecision(stateDir, id)).decision, `keep:reason-${reason}`); assert.equal(serverAlive(stateDir), true); }
});

test('two sessions: first end keeps server, second stops it after grace', async (t) => {
  const { cwd, env, stateDir } = setup(t, { extra: { OPC_REAP_GRACE_MS: '300' } }); await startServer(env, cwd); const record = readServerRecord(stateDir);
  await hook(env, cwd, 'hook-session-start', { session_id: 'first' }); await hook(env, cwd, 'hook-session-start', { session_id: 'second' });
  await hook(env, cwd, 'hook-session-end', { session_id: 'first', reason: 'prompt_input_exit' }); assert.equal((await reaperDecision(stateDir, 'first')).decision, 'keep:live-sessions'); assert.equal(serverAlive(stateDir), true);
  await hook(env, cwd, 'hook-session-end', { session_id: 'second', reason: 'other' }); const decision = await reaperDecision(stateDir, 'second');
  assert.equal(decision.decision, 'stop'); assert.equal(decision.result.stopped, true); await waitFor(() => !isPidAlive(record.pid), { timeoutMs: 20000, message: 'server process exit' });
});

test('a job registered during grace keeps server', async (t) => {
  const { cwd, env, stateDir } = setup(t, { scenario: 'review-slow', extra: { OPC_REAP_GRACE_MS: '3000', FAKE_SLOW_MS: '60000' } });
  writeFile(cwd, 'src/app.js', "export const value = 'RACE_MARKER';\n"); await startServer(env, cwd); await hook(env, cwd, 'hook-session-start', { session_id: 'leaving' }); await hook(env, cwd, 'hook-session-end', { session_id: 'leaving', reason: 'other' });
  const started = await runCli(['review', '--background', '--json'], { env: { ...env, OPC_COMPANION_SESSION_ID: 'another' }, cwd }); assert.equal(started.code, 0, started.stderr);
  const { jobId } = JSON.parse(started.stdout);
  registerStopper(t, async () => {
    const cancelled = await runCli(['cancel', jobId], { env, cwd });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    return await stopServer({ stateDir, workspaceRoot: cwd, config: {}, env, hasActiveJobs: () => false }, { force: true, confirmedByUser: true });
  });
  assert.equal((await reaperDecision(stateDir, 'leaving')).decision, 'keep:active-jobs'); assert.equal(serverAlive(stateDir), true);
});

test('the real job registration path waits for server.lock before creating the record', async (t) => {
  const { cwd, env, stateDir } = setup(t, { scenario: 'review-ok' }); writeFile(cwd, 'src/app.js', "export const value = 'LOCK_MARKER';\n"); await startServer(env, cwd);
  const release = await acquireLock(serverLockPath(stateDir), { timeoutMs: 1000, purpose: 'test-reaper-simulation' }); let released = false;
  registerStopper(t, () => { if (!released) release(); }); const pending = runCli(['review', '--background'], { env, cwd }); await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(listJobs(stateDir, { all: true }).filter((job) => job.kind === 'review').length, 0); release(); released = true; const result = await pending; assert.equal(result.code, 0, result.stderr);
  assert.equal(listJobs(stateDir, { all: true }).filter((job) => job.kind === 'review').length, 1);
});

test('reaper cancels active jobs belonging to ended session', async (t) => {
  const { cwd, env, stateDir } = setup(t, { scenario: 'review-slow', extra: { FAKE_SLOW_MS: '60000' } }); writeFile(cwd, 'src/app.js', "export const value = 'CANCEL_MARKER';\n");
  await hook(env, cwd, 'hook-session-start', { session_id: 'owner' }); const started = await runCli(['review', '--background', '--json'], { env: { ...env, OPC_COMPANION_SESSION_ID: 'owner' }, cwd }); assert.equal(started.code, 0, started.stderr);
  const { jobId } = JSON.parse(started.stdout); await hook(env, cwd, 'hook-session-end', { session_id: 'owner', reason: 'clear' });
  assert.equal((await reaperDecision(stateDir, 'owner', 40000)).decision, 'keep:reason-clear'); await waitFor(() => readJob(stateDir, jobId)?.status === 'cancelled', { timeoutMs: 30000, message: `${jobId} cancelled` });
});
