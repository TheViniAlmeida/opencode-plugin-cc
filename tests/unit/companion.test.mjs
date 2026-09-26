import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { MIN_NODE_MAJOR, listSubcommands, loadCommand, main, nodeVersionOk } from '../../plugins/opc/scripts/opc-companion.mjs';

function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  stream.text = () => chunks.join('');
  return stream;
}

test('Node guard requires major >= 20', () => {
  assert.equal(MIN_NODE_MAJOR, 20);
  assert.equal(nodeVersionOk('18.19.0'), false);
  assert.equal(nodeVersionOk('20.0.0'), true);
  assert.equal(nodeVersionOk('22.3.1'), true);
});

test('subcommands are discovered from commands/ (setup included, sorted)', () => {
  const subs = listSubcommands();
  assert.ok(subs.includes('setup'), subs.join(','));
  assert.deepEqual(subs, [...subs].sort());
});

test('loadCommand imports only valid names that map to commands/<name>.mjs', async () => {
  assert.equal(typeof (await loadCommand('setup')).run, 'function');
  for (const bad of ['../x', '../lib/state', '', 'Setup', 'nope']) {
    await assert.rejects(loadCommand(bad), (e) => e.code === 'USAGE' && e.exitCode === 2, bad);
  }
});

test('main: unknown or invalid subcommand exits 2, calls onError before rendering and lists the subcommands', async () => {
  for (const sub of ['nope', '../x']) {
    const stdout = sink();
    const stderr = sink();
    const seen = [];
    const code = await main([sub, '--json'], {
      stdin: Readable.from([]), stdout, stderr, env: {}, cwd: '/nonexistent',
      onError: (err) => seen.push({ code: err.code, stderrSoFar: stderr.text() }),
    });
    assert.equal(code, 2);
    assert.deepEqual(seen, [{ code: 'USAGE', stderrSoFar: '' }]);
    assert.match(stderr.text(), /Disponíveis: .*setup/);
    assert.equal(JSON.parse(stdout.text()).error.code, 'USAGE');
  }
});
