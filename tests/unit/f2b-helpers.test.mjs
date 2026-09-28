import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTempDir, spawnSleeper, trackTempDir } from '../helpers.mjs';
import { getProcessIdentity } from '../../plugins/opc/scripts/lib/process.mjs';
import { readJsonLines, serverAlive } from '../f2b-helpers.mjs';

function tempDir(t) {
  return trackTempDir(t, makeTempDir('opc-f2b-helpers-'));
}

test('readJsonLines returns [] only when the file does not exist', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readJsonLines(path.join(dir, 'missing.jsonl')), []);

  assert.throws(() => readJsonLines(dir), /EISDIR|directory/i);
});

test('readJsonLines reports malformed JSON with file and 1-based line number', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'records.jsonl');
  fs.writeFileSync(file, '{"ok":true}\nnot-json\n');

  assert.throws(() => readJsonLines(file), (error) => {
    assert.match(error.message, /records\.jsonl/);
    assert.match(error.message, /line 2/i);
    return true;
  });
});

test('serverAlive rejects a live PID whose recorded process identity does not match', (t) => {
  const child = spawnSleeper(t);
  const dir = tempDir(t);
  const identity = getProcessIdentity(child.pid);
  assert.ok(identity, 'sleeper should have a readable live process identity');
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({
    schemaVersion: 1,
    pid: child.pid,
    startTime: identity.startTime,
    port: 12345,
    password: 'fixture-only',
  }));

  assert.equal(serverAlive(dir), false);
});
