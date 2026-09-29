import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../plugins/opc/scripts/opc-companion.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

for (const existing of [true, false]) {
  test(`F4a I5: monitor context is read-only (data exists: ${existing})`, async (t) => {
    const root = trackTempDir(t, makeTempDir('opc-monitor-readonly-'));
    const cwd = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(cwd);
    if (existing) fs.mkdirSync(dataDir);
    const before = fs.readdirSync(root, { recursive: true }).sort();
    let output = '';
    const sink = { write(text) { output += text; } };
    const code = await main(['monitor', '--once'], { cwd, env: { ...process.env, OPC_DATA_DIR: dataDir }, stdout: sink, stderr: sink });
    assert.equal(code, 0, output);
    assert.match(output, /Nenhum job neste workspace/);
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before);
  });
}
