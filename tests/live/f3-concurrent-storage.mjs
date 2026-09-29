import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, record, note } from './_f3-lib.mjs';

function runOpencode(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OPC_')) delete env[key];
    const child = spawn('opencode', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const startedAt = Date.now();
    // Timeout sends SIGTERM through this test's spawned ChildProcess handle only.
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, startedAt, completedAt: Date.now() }); });
  });
}

test('F3 live (§15 item 12): opencode run simultâneo a um job opc no mesmo projeto', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir, stateDir } = liveWorkspace(t);
  const bg = await opc(['ask', '--background', '--model', MODELS.deepseek, 'List the files in this repository and describe each one in one line.'], { env, cwd: ws });
  record('opc ask --background', bg, dataDir);
  assert.equal(bg.code, 0, bg.stderr);
  const jobId = (bg.stdout.match(/\bask-[a-z0-9]+-[a-z0-9]+\b/) ?? [])[0];
  assert.ok(jobId, 'id do job impresso');
  const beforeRun = await opc(['status', jobId, '--json'], { env, cwd: ws });
  record('opc status --json (imediatamente antes do opencode run)', beforeRun, dataDir);
  assert.equal(beforeRun.code, 0, beforeRun.stderr);
  const runningJob = JSON.parse(beforeRun.stdout).job;
  assert.equal(runningJob.status, 'running', 'background job must be running immediately before opencode run');
  const direct = await runOpencode(['run', '-m', MODELS.deepseek, 'Reply with the single word OK.'], { cwd: ws, timeoutMs: 15 * 60_000 });
  record('opencode run (concorrente)', direct, dataDir);
  const waited = await opc(['status', jobId, '--wait', '--timeout-ms', '1800000'], { env, cwd: ws });
  record('opc status --wait', waited, dataDir);
  const finalStatus = await opc(['status', jobId, '--json'], { env, cwd: ws });
  record('opc status --json (após ambos terminarem)', finalStatus, dataDir);
  assert.equal(finalStatus.code, 0, finalStatus.stderr);
  const finishedJob = JSON.parse(finalStatus.stdout).job;
  const logFile = join(stateDir(), 'server.log'); const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const lockErrors = /SQLITE_BUSY|database is locked/i.test(log);
  const all = JSON.parse((await opc(['sessions', '--all', '--json'], { env, cwd: ws })).stdout).sessions;
  const refreshed = await opc(['sessions', '--all', '--refresh', '--json'], { env, cwd: ws });
  record('opc sessions --all --refresh --json (após o job terminar)', refreshed, dataDir);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  const afterRefresh = JSON.parse(refreshed.stdout).sessions;
  const findings = { opencodeRunExit: direct.code, opcJobExit: waited.code, jobStartedAt: runningJob.startedAt,
    opencodeRunStartedAt: new Date(direct.startedAt).toISOString(), opencodeRunCompletedAt: new Date(direct.completedAt).toISOString(),
    jobCompletedAt: finishedJob.completedAt, lockErrorsInServerLog: lockErrors,
    nonOpcSessionVisibleToPluginServer: all.some((s) => !String(s.title).startsWith('OPC: ')),
    nonOpcSessionVisibleToPluginServerAfterRefresh: afterRefresh.some((s) => !String(s.title).startsWith('OPC: ')) };
  note('§15 item 12 — parte automatizada', findings, dataDir);
  assert.equal(direct.code, 0, direct.stderr); assert.equal(waited.code, 0, waited.stderr);
  assert.ok(Date.parse(runningJob.startedAt) < direct.completedAt, 'opc job started before opencode run finished');
  assert.ok(Date.parse(finishedJob.completedAt) > direct.startedAt, 'opc job completed after opencode run started');
  assert.equal(lockErrors, false);
});
