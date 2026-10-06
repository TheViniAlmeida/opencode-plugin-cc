import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

const exitCodeBeforeImport = process.exitCode;
const { main: dispatch } = await import('../../plugins/opc/scripts/opc-companion.mjs');

function sink() {
  const chunks = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
  stream.isTTY = false;
  stream.text = () => chunks.join('');
  return stream;
}

function noStdin() { const stream = Readable.from([]); stream.isTTY = false; return stream; }

test('importing the companion does not run the CLI (F0 invokedDirectly guard)', () => {
  assert.equal(typeof dispatch, 'function');
  assert.equal(process.exitCode, exitCodeBeforeImport);
});

test('main dispatches the subcommand and literal argv tail through injected boundaries', async () => {
  const tail = ['--flag', '--', '--resume', 'literal prompt'];
  const ctx = { marker: 'injected context' };
  let loadedName;
  let received;
  const code = await dispatch(['fake-command', ...tail], {
    env: {}, cwd: os.tmpdir(), stdin: noStdin(), stdout: sink(), stderr: sink(),
    commandLoader: async (name) => { loadedName = name; return { run: async (gotCtx, argv) => { received = [gotCtx, argv]; return 37; } }; },
    contextFactory: async () => ctx,
  });
  assert.equal(loadedName, 'fake-command');
  assert.deepEqual(received, [ctx, tail]);
  assert.equal(code, 37);
});

test('unknown subcommand: exit 2, io.onError gets the typed USAGE error, stderr gets the rendered error', async () => {
  let seen = null;
  const stderr = sink();
  const stdout = sink();
  const code = await dispatch(['definitely-not-a-command', '--json'], { env: {}, cwd: os.tmpdir(), stdin: noStdin(), stdout, stderr, onError: (err) => { seen = err; } });
  assert.equal(code, 2);
  assert.equal(seen.code, 'USAGE');
  assert.equal(seen.exitCode, 2);
  assert.match(stderr.text(), /opc error/);
  assert.equal(JSON.parse(stdout.text()).error.code, 'USAGE');
});

test('main runs a real subcommand with the injected env, cwd and streams', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-dispatch-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stdout = sink();
  const code = await dispatch(['config', 'path'], { env: { ...process.env, OPC_DATA_DIR: dir }, cwd: dir, stdin: noStdin(), stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.ok(stdout.text().includes(dir), stdout.text());
});
