import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { startMcpClient } from '../helpers.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

test('MCP client rejects pending requests immediately when child exits', async () => {
  const child = fakeChild();
  const client = startMcpClient({ env: {}, cwd: '.', timeoutMs: 120000, spawn: () => child });
  const pending = client.request('initialize', {});
  child.emit('exit', 17);
  await assert.rejects(pending, /child exited before response \(code 17\)/);
  assert.equal(await client.exited, 17);
});

test('MCP client rejects startup errors without exposing stderr credentials', async () => {
  const child = fakeChild();
  const client = startMcpClient({ env: {}, cwd: '.', timeoutMs: 120000, spawn: () => child });
  const pending = client.request('initialize', {});
  child.stderr.write('Authorization: Bearer abcdefghijklmnop');
  child.emit('error', new Error('spawn failed'));
  await assert.rejects(pending, /child failed to start/);
  assert.doesNotMatch((await pending.catch((error) => error.message)), /abcdefghijklmnop/);
});
