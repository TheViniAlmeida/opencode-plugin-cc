import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWorkspace, parseJsonOutput, runCli, testEnv } from '../helpers.mjs';

test('session todo is gone in V2', async (t) => {
  const result = await runCli(['session', 'todo', 'ses_x', '--json'], { env: testEnv(t), cwd: makeWorkspace(t) });
  assert.equal(result.code, 2);
  assert.equal(parseJsonOutput(result.stdout).error.code, 'UNKNOWN_SUBCOMMAND');
});
