import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { collectTestFiles, supportsTestConcurrency, nodeVersionExitCode } from '../../scripts/run-tests.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

function touch(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('collectTestFiles finds *.test.mjs recursively under unit and integration, sorted', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/unit/b.test.mjs');
  touch(root, 'tests/unit/a.test.mjs');
  touch(root, 'tests/unit/nested/c.test.mjs');
  touch(root, 'tests/unit/helper.mjs');
  touch(root, 'tests/integration/x.test.mjs');
  const files = collectTestFiles(root).map((f) => path.relative(root, f));
  assert.deepEqual(files, [
    path.join('tests', 'unit', 'a.test.mjs'),
    path.join('tests', 'unit', 'b.test.mjs'),
    path.join('tests', 'unit', 'nested', 'c.test.mjs'),
    path.join('tests', 'integration', 'x.test.mjs'),
  ]);
});

test('collectTestFiles for live skips standalone scripts (contract, probe-*) and support modules (_*)', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  touch(root, 'tests/live/f0-connection.mjs');
  touch(root, 'tests/live/contract.mjs');
  touch(root, 'tests/live/probe-permission-precedence.mjs');
  touch(root, 'tests/live/_f2a-helpers.mjs');
  const files = collectTestFiles(root, ['live']).map((f) => path.basename(f));
  assert.deepEqual(files, ['f0-connection.mjs']);
});

test('supportsTestConcurrency is true from Node 20.10', () => {
  assert.equal(supportsTestConcurrency('20.9.0'), false);
  assert.equal(supportsTestConcurrency('20.10.0'), true);
  assert.equal(supportsTestConcurrency('22.1.0'), true);
});

test('collectTestFiles propagates non-ENOENT directory errors', (t) => {
  const root = makeTempDir('opc-rt-');
  t.after(() => removeTempDir(root));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'unit'), 'not a directory');
  assert.throws(() => collectTestFiles(root, ['unit']), { code: 'ENOTDIR' });
});

test('Node CLI version guard returns exit 2 below major 20', () => {
  assert.equal(nodeVersionExitCode('v18.20.0'), 2);
  assert.equal(nodeVersionExitCode('v20.0.0'), 0);
});
