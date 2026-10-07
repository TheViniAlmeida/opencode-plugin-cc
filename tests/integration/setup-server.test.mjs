import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { acquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import {
  makeTempDir, makeWorkspace, parseJsonOutput, processAlive, readFakeState, runCli, testEnv, trackTempDir, waitFor,
} from '../helpers.mjs';

async function setupJson(env, cwd, extra = []) {
  const res = await runCli(['setup', '--json', ...extra], { env, cwd });
  return { ...res, report: parseJsonOutput(res.stdout) };
}

test('CLI: setup starts the server, the spawner exits, the next setup reuses it (no EPIPE), --stop-server stops it', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  assert.equal(first.code, 0, first.stderr);
  const { pid, port } = first.report.server;
  assert.ok(processAlive(pid), 'server outlives the setup process');
  const second = await setupJson(env, ws);
  assert.equal(second.report.server.reused, true);
  assert.equal(second.report.server.pid, pid);
  const log = fs.readFileSync(path.join(first.report.stateDir, 'server.log'), 'utf8');
  assert.match(log, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  assert.ok(!/EPIPE/.test(log));
  const stop = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(stop.code, 0);
  assert.deepEqual(parseJsonOutput(stop.stdout).stop, { stopped: true, reason: 'terminated' });
  await waitFor(() => !processAlive(pid), { message: 'server gone' });
  const md = await runCli(['setup', '--stop-server'], { env, cwd: ws });
  assert.match(md.stdout, /nenhum servidor do opc rodando/);
});

test('CLI: two concurrent setups (separate processes) produce a single spawn', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const [a, b] = await Promise.all([setupJson(env, ws), setupJson(env, ws)]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.report.server.pid, b.report.server.pid);
  assert.deepEqual([a.report.server.reused, b.report.server.reused].sort(), [false, true]);
  assert.equal(readFakeState(env).bootAttempts, 1);
});

test('CLI: --stop-server with active jobs exits 2 listing them; --force needs --confirmed-by-user', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  const job = await createJob(first.report.stateDir, { kind: 'task', title: 'long job' });
  const refused = await runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  assert.equal(refused.code, 2);
  const body = parseJsonOutput(refused.stdout);
  assert.equal(body.stop.reason, 'active-jobs');
  assert.deepEqual(body.activeJobs.map((j) => j.id), [job.id]);
  const md = await runCli(['setup', '--stop-server'], { env, cwd: ws });
  assert.match(md.stdout, new RegExp(`\\| ${job.id} \\| task \\| queued \\| long job \\|`));
  const noConfirm = await runCli(['setup', '--stop-server', '--force', '--json'], { env, cwd: ws });
  assert.equal(noConfirm.code, 2);
  assert.equal(parseJsonOutput(noConfirm.stdout).error.code, 'CONFIRMATION_REQUIRED');
  const misuse = await runCli(['setup', '--force'], { env, cwd: ws });
  assert.equal(misuse.code, 2);
  const forced = await runCli(['setup', '--stop-server', '--force', '--confirmed-by-user', '--json'], { env, cwd: ws });
  assert.equal(forced.code, 0);
  assert.equal(parseJsonOutput(forced.stdout).stop.stopped, true);
});

test('CLI: --stop-server rechecks jobs created while waiting for server.lock', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const first = await setupJson(env, ws);
  assert.equal(first.code, 0, first.stderr);
  const release = await acquireLock(path.join(first.report.stateDir, 'server.lock'), { timeoutMs: 1000, purpose: 'test-race' });
  const stopping = runCli(['setup', '--stop-server', '--json'], { env, cwd: ws });
  const job = await createJob(first.report.stateDir, { kind: 'task', title: 'created while stop waits' });
  release();

  const refused = await stopping;
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  const body = parseJsonOutput(refused.stdout);
  assert.equal(body.stop.reason, 'active-jobs');
  assert.deepEqual(body.activeJobs.map((item) => item.id), [job.id]);
  const forced = await runCli(['setup', '--stop-server', '--force', '--confirmed-by-user', '--json'], { env, cwd: ws });
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
});

test('workspace-with-spaces: git (from a subdir) and non-git dirs with spaces/accents keep exact directory and hash', async (t) => {
  const env = testEnv(t);
  const gitWs = makeWorkspace(t, { name: 'meu projeto ação' });
  fs.mkdirSync(path.join(gitWs, 'sub dir'));
  const fromSub = await setupJson(env, path.join(gitWs, 'sub dir'));
  assert.equal(fromSub.code, 0, fromSub.stderr);
  assert.equal(fromSub.report.workspaceRoot, gitWs);
  assert.match(path.basename(fromSub.report.stateDir), /^meu-projeto-acao-[0-9a-f]{16}$/);
  const plainBase = trackTempDir(t, makeTempDir('opc-plain-'));
  const plain = path.join(plainBase, 'sem git é aqui');
  fs.mkdirSync(plain);
  const res = await setupJson(env, plain);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.report.workspaceRoot, plain);
  assert.notEqual(res.report.stateDir, fromSub.report.stateDir);
  const fake = readFakeState(env);
  const dirs = fake.requests.filter((r) => r.path === '/api/agent').map((r) => r.directory);
  assert.ok(dirs.includes(gitWs));
  assert.ok(dirs.includes(plain));
  assert.ok(fake.boots.some((b) => b.cwd === plain));
  await runCli(['setup', '--stop-server', '--json'], { env, cwd: plain });
});
