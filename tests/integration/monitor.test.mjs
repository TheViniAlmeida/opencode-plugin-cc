import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  testEnv, makeWorkspace, runCli, COMPANION, FIXTURE_MODELS as M, stateDirFor, waitFor, registerStopper,
} from '../helpers.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { createJob, updateJob, appendJobLog } from '../../plugins/opc/scripts/lib/jobs.mjs';

async function seed(env, ws) {
  const stateDir = stateDirFor(env, ws);
  ensurePrivateDir(stateDir);
  const t0 = Date.now();
  const running = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: where is main' });
  await updateJob(stateDir, running.id, {
    status: 'running', phase: 'investigating', model: M.k3, attemptLimit: 3,
    startedAt: new Date(t0 - 5000).toISOString(),
    attempts: [{ model: M.fast, sessionID: 'ses_a1', status: 'failed', errorClass: 'recoverable', errorType: 'APIError', startedAt: new Date(t0 - 5000).toISOString(), endedAt: new Date(t0 - 4000).toISOString() }],
  });
  appendJobLog(stateDir, running.id, `fallback: APIError em ${M.fast}; próximo ${M.k3} em 2s`);
  const waiting = await createJob(stateDir, { kind: 'task', title: 'OPC: task: clean the build' });
  await updateJob(stateDir, waiting.id, {
    status: 'waiting_permission', phase: 'verifying', model: M.fast, attemptLimit: 1,
    pendingRequest: { id: 'per_f4a1', type: 'permission', permission: 'bash', patterns: ['rm -rf dist'] },
  });
  const done = await createJob(stateDir, { kind: 'plan', title: 'OPC: plan: refactor parser' });
  await updateJob(stateDir, done.id, { status: 'completed', phase: 'finalizing', model: M.strong, completedAt: new Date(t0).toISOString() });
  return { stateDir, running, waiting, done };
}

test('monitor --once shows phase, model, attempt, pending request and log tail', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { running, waiting, done } = await seed(env, ws);
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /opc monitor — .* — 2 ativo\(s\), 1 recente\(s\)/);
  assert.ok(r.stdout.includes(`● ${running.id}  running  investigating  ${M.k3}  tentativa 2/3`), r.stdout);
  assert.ok(r.stdout.includes(`⏸ ${waiting.id}  waiting_permission  verifying`), r.stdout);
  assert.match(r.stdout, /permissão per_f4a1: bash \[rm -rf dist\] → \/opc:permissions reply per_f4a1 once\|reject/);
  assert.ok(r.stdout.includes(`✓ ${done.id}  completed`), r.stdout);
  assert.match(r.stdout, /│ .*fallback: APIError em/);
  assert.doesNotMatch(r.stdout, /\x1b\[/, 'no ANSI when stdout is not a TTY');
});

test('monitor --color always emits ANSI colors', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  await seed(env, ws);
  const r = await runCli(['monitor', '--once', '--color', 'always'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\x1b\[36m●/);
});

test('monitor --json prints the snapshot', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { running } = await seed(env, ws);
  const r = await runCli(['monitor', '--once', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  const snap = JSON.parse(r.stdout);
  assert.equal(snap.focus, null);
  assert.equal(snap.jobs.length, 3);
  const entry = snap.jobs.find((j) => j.id === running.id);
  assert.deepEqual(entry.attempt, { current: 2, limit: 3 });
  assert.equal(entry.model, M.k3);
});

test('monitor --once --json masks unregistered secret-like values in titles, logs and attempt errors', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const stateDir = stateDirFor(env, ws);
  ensurePrivateDir(stateDir);
  const secret = `ghp_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const job = await createJob(stateDir, { kind: 'ask', title: `title ${secret}` });
  await updateJob(stateDir, job.id, {
    status: 'failed', completedAt: new Date().toISOString(),
    attempts: [{ status: 'failed', errorMessage: `attempt failed ${secret}` }],
  });
  appendJobLog(stateDir, job.id, `log ${secret}`);
  const r = await runCli(['monitor', '--once', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, new RegExp(secret));
  assert.ok(r.stdout.includes('***'), r.stdout);
});

test('monitor shows every member of a visible group beyond the top-level recent cap', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const stateDir = stateDirFor(env, ws);
  ensurePrivateDir(stateDir);
  const group = await createJob(stateDir, { kind: 'orchestrate', title: 'group' });
  await updateJob(stateDir, group.id, { status: 'running' });
  const completed = await createJob(stateDir, { kind: 'task', title: 'completed member', groupId: group.id });
  await updateJob(stateDir, completed.id, { status: 'completed', completedAt: new Date().toISOString() });
  const running = await createJob(stateDir, { kind: 'task', title: 'running member', groupId: group.id });
  await updateJob(stateDir, running.id, { status: 'running' });
  for (let i = 0; i < 15; i += 1) {
    const job = await createJob(stateDir, { kind: 'ask', title: `recent ${i}` });
    await updateJob(stateDir, job.id, { status: 'completed', completedAt: new Date(Date.now() + i).toISOString() });
  }
  const snap = JSON.parse((await runCli(['monitor', '--json'], { env, cwd: ws })).stdout);
  assert.ok(snap.jobs.some((j) => j.id === completed.id), JSON.stringify(snap.jobs.map((j) => j.id)));
  assert.ok(snap.jobs.some((j) => j.id === running.id), JSON.stringify(snap.jobs.map((j) => j.id)));
});

test('monitor skips malformed job ids and continues rendering valid records', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { stateDir, running } = await seed(env, ws);
  fs.writeFileSync(path.join(stateDir, 'jobs', 'x.json'), JSON.stringify({ id: '../evil', status: 'running' }));
  fs.writeFileSync(path.join(stateDir, 'jobs', 'task-wrong-123456.json'), JSON.stringify({ id: running.id, status: 'failed' }));
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(running.id), r.stdout);
  assert.doesNotMatch(r.stdout, /evil|task-wrong/);
});

test('monitor reports jobs directory read errors and --once exits 5', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const stateDir = stateDirFor(env, ws);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jobs'), 'not a directory');
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stdout, /aviso: não foi possível ler .*jobs: ENOTDIR/);
});

test('monitor warns about a per-file read error and continues with valid jobs', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { stateDir, running } = await seed(env, ws);
  fs.mkdirSync(path.join(stateDir, 'jobs', 'ask-extra-123456.json'));
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /aviso: não foi possível ler ask-extra-123456\.json: EISDIR/);
  assert.ok(r.stdout.includes(running.id), r.stdout);
});

test('monitor --job <prefix> focuses one job and lists its attempts', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { running, done } = await seed(env, ws);
  const r = await runCli(['monitor', '--once', '--job', running.id.slice(0, 10)], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tentativas:/);
  assert.ok(r.stdout.includes(`1. ${M.fast} — failed (recoverable APIError)`), r.stdout);
  assert.ok(!r.stdout.includes(done.id), 'focused view shows only the job (and its group members)');
});

test('monitor --job with an unknown id exits 2', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  await seed(env, ws);
  const r = await runCli(['monitor', '--once', '--job', 'zzz-nope'], { env, cwd: ws });
  assert.equal(r.code, 2);
});

test('monitor rejects invalid --color and --interval with exit 2', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  assert.equal((await runCli(['monitor', '--once', '--color', 'rainbow'], { env, cwd: ws })).code, 2);
  assert.equal((await runCli(['monitor', '--once', '--interval', '10'], { env, cwd: ws })).code, 2);
});

test('monitor with no state', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Nenhum job neste workspace\./);
});

test('monitor survives a corrupted job file and changes nothing', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const { stateDir, running } = await seed(env, ws);
  const garbage = path.join(stateDir, 'jobs', 'garbage.json');
  fs.writeFileSync(garbage, '{truncated');
  const jobFile = path.join(stateDir, 'jobs', `${running.id}.json`);
  const before = fs.readFileSync(jobFile, 'utf8');
  const stateBefore = fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8');
  const r = await runCli(['monitor', '--once'], { env, cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(running.id));
  assert.equal(fs.readFileSync(garbage, 'utf8'), '{truncated');
  assert.equal(fs.readFileSync(jobFile, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'), stateBefore);
});

test('monitor refreshes until SIGINT and exits 0', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  await seed(env, ws);
  const child = spawn(process.execPath, [COMPANION, 'monitor', '--interval', '100'], { env, cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] });
  registerStopper(t, () => child.kill('SIGKILL')); // before the F0 cleanup removes the workspace
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await waitFor(() => (out.match(/opc monitor —/g) ?? []).length >= 3, { timeoutMs: 15_000 });
  child.kill('SIGINT');
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
});
