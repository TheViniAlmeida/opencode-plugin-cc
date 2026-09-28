// F2a live check: task --write creates a workspace file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_SKIP, atLeast, liveSetup, opcLive } from './_f2a-helpers.mjs';

test('live: task --write creates a file', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t);
  const target = join(ctx.cwd, 'hello.txt');
  const passed = await atLeast(2, 3, 'task --write cria arquivo', async () => {
    const r = await opcLive(ctx, ['task', '--write', '--raw-args-stdin'], {
      stdin: 'Create a file named hello.txt in the workspace root containing exactly the text: opc-f2a-live',
    });
    return r.code === 0 && existsSync(target) && readFileSync(target, 'utf8').trim() === 'opc-f2a-live';
  });
  assert.ok(passed);
});
