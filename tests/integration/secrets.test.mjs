import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_ROOT, makeTempDir, makeWorkspace, parseJsonOutput, readJsonFile, runCli, runProcess, testEnv, trackTempDir,
} from '../helpers.mjs';

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

test('no output, log or state file (other than server.json) contains the server password', async (t) => {
  const env = testEnv(t, { scenario: 'ignores-sigterm' });
  const ws = makeWorkspace(t);
  const outputs = [];
  const run = async (args) => {
    const res = await runCli(args, { env, cwd: ws });
    outputs.push(res.stdout, res.stderr);
    return res;
  };
  const first = await run(['setup', '--json']);
  const { stateDir } = parseJsonOutput(first.stdout);
  const serverJson = path.join(stateDir, 'server.json');
  const { password } = readJsonFile(serverJson);
  assert.equal(password.length, 48);
  const keep = trackTempDir(t, makeTempDir('opc-secret-'));
  fs.copyFileSync(serverJson, path.join(keep, 'server.json'));
  await run(['setup']);
  await run(['setup', '--json']);
  await run(['setup', '--bogus', '--json']);
  await run(['setup', '--stop-server', '--json']);
  await run(['setup', '--stop-server']);

  for (const text of outputs) assert.ok(!text.includes(password), 'CLI output leaked the password');
  const dataFiles = filesUnder(env.OPC_DATA_DIR);
  for (const file of dataFiles) {
    if (path.basename(file) === 'server.json') continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes(password), `${file} leaked the password`);
  }
  assert.ok(!fs.readFileSync(env.FAKE_OPENCODE_STATE, 'utf8').includes(password), 'fake state leaked the password');

  const dump = path.join(keep, 'dump');
  fs.mkdirSync(dump);
  fs.writeFileSync(path.join(dump, 'outputs.txt'), outputs.join('\n'));
  for (const file of dataFiles.filter((f) => path.basename(f) !== 'server.json')) {
    fs.copyFileSync(file, path.join(dump, `${path.basename(path.dirname(file))}-${path.basename(file)}`));
  }
  const scan = await runProcess(process.execPath, [path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs'), dump, '--server-json', path.join(keep, 'server.json')], { env: { PATH: process.env.PATH } });
  assert.equal(scan.code, 0, scan.stdout + scan.stderr);
});
