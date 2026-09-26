// Live F0 checklist (spec §13.3 F0): real `opc setup`, port != 4096, reuse, stop without orphans,
// pre-existing user `opencode serve` processes untouched. Runs only with OPC_LIVE=1.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { COMPANION, makeTempDir, parseJsonOutput, registerStopper, runProcess, trackTempDir } from '../helpers.mjs';
import { stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';

const LIVE = process.env.OPC_LIVE === '1';
const LINUX = process.platform === 'linux';

function listOpencodeServe() {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const identity = getProcessIdentity(Number(name));
    if (!identity) continue;
    const isOpencode = identity.cmdline.slice(0, 3).some((a) => /^opencode(\.exe)?$/.test(path.basename(a)));
    if (isOpencode && identity.cmdline.includes('serve')) out.push(identity);
  }
  return out;
}

function processGroupMembers(pgid) {
  const members = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') members.push(Number(name));
    } catch {
      // process vanished while scanning
    }
  }
  return members;
}

function liveEnv(dataDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_|OPENCODE_SERVER_|FAKE_)/.test(k)));
  return { ...env, OPC_DATA_DIR: dataDir };
}

async function opc(args, { env, cwd }) {
  const started = Date.now();
  const res = await runProcess(process.execPath, [COMPANION, ...args], { env, cwd, timeoutMs: 240000 });
  return { ...res, ms: Date.now() - started };
}

if (!LIVE) {
  test('F0 live checklist (set OPC_LIVE=1 to run)', { skip: 'OPC_LIVE != 1' }, () => {});
} else {
  test('F0 live: real setup, port != 4096, reuse, stop without orphans, user servers untouched', { skip: !LINUX && 'Linux only', timeout: 600000 }, async (t) => {
    const base = trackTempDir(t, makeTempDir('opc-live-f0-'));
    const ws = path.join(base, 'workspace live');
    fs.mkdirSync(ws);
    execFileSync('git', ['init', '-q'], { cwd: ws });
    const env = liveEnv(path.join(base, 'data'));
    const cleanupCtx = { stateDir: workspaceStateDir(path.join(base, 'data'), ws), workspaceRoot: ws, config: mergeConfig({}, null).config, env };
    registerStopper(t, () => stopServer(cleanupCtx, { force: true, confirmedByUser: true }));
    const userServersBefore = listOpencodeServe();
    console.log(`[live] opencode serve preexistentes: ${userServersBefore.length}`);

    const first = await opc(['setup', '--json'], { env, cwd: ws });
    const r1 = parseJsonOutput(first.stdout);
    console.log(`[live] setup #1: exit ${first.code} em ${first.ms} ms; porta ${r1.server?.port}; versão ${r1.server?.version}`);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(r1.server.status, 'running');
    assert.equal(r1.server.reused, false);
    assert.notEqual(r1.server.port, 4096);
    const { pid, port } = r1.server;
    const identity = getProcessIdentity(pid);
    assert.ok(identity.cmdline.includes('serve') && identity.cmdline.includes(String(port)), identity.cmdline.join(' '));

    const serverJson = path.join(r1.stateDir, 'server.json');
    const record = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
    assert.equal(fs.statSync(serverJson).mode & 0o777, 0o600);
    const client = createClient({ baseUrl: record.url, password: record.password, directory: ws });
    const health = await client.get('/global/health');
    console.log(`[live] health: healthy=${health.healthy} version=${health.version}`);
    assert.equal(health.healthy, true);

    const second = await opc(['setup', '--json'], { env, cwd: ws });
    const r2 = parseJsonOutput(second.stdout);
    console.log(`[live] setup #2: exit ${second.code} em ${second.ms} ms; reaproveitado=${r2.server?.reused}`);
    assert.equal(r2.server.reused, true);
    assert.equal(r2.server.pid, pid);

    const stop = await opc(['setup', '--stop-server', '--json'], { env, cwd: ws });
    const r3 = parseJsonOutput(stop.stdout);
    console.log(`[live] stop: exit ${stop.code} em ${stop.ms} ms; ${JSON.stringify(r3.stop)}`);
    assert.equal(stop.code, 0);
    assert.equal(r3.stop.stopped, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(getProcessIdentity(pid), null, 'server pid still alive');
    assert.deepEqual(processGroupMembers(pid), [], 'orphan processes left in the server group');
    const leftovers = listOpencodeServe().filter((p) => p.cmdline.includes(String(port)));
    assert.deepEqual(leftovers, [], 'an opencode serve with our port is still running');

    for (const before of userServersBefore) {
      const now = getProcessIdentity(before.pid);
      assert.ok(now && String(now.startTime) === String(before.startTime), `user server ${before.pid} was affected`);
    }
    console.log(`[live] opencode serve preexistentes intactos: ${userServersBefore.length}/${userServersBefore.length}`);

    for (const text of [first.stdout, first.stderr, second.stdout, second.stderr, stop.stdout, stop.stderr]) {
      assert.ok(!text.includes(record.password), 'password leaked in CLI output');
    }
    const log = fs.readFileSync(path.join(r1.stateDir, 'server.log'), 'utf8');
    assert.ok(!log.includes(record.password), 'password leaked in server.log');
    assert.match(log, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  });
}
