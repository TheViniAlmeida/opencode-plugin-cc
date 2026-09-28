import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';

import { runCli, testEnv } from '../helpers.mjs';
import { fixtureModelIds, makeMainRepo, writeGlobalConfig } from '../f2b-helpers.mjs';
import { createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { withServerLock } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { readServerRecord, stopServer } from '../../plugins/opc/scripts/lib/server.mjs';

test('stopServer({ lockHeld: true }) runs while caller holds server.lock', async (t) => {
  const cwd = makeMainRepo(t);
  const env = testEnv(t, { scenario: 'ok' });
  writeGlobalConfig(env, { defaultModel: fixtureModelIds()[0], server: { bootTimeoutSec: 5 } });
  const started = await runCli(['setup', '--json'], { env, cwd });
  assert.equal(started.code, 0, started.stderr);
  const ctx = await createContext({ argv: [], env, cwd, stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
  const record = readServerRecord(ctx.stateDir);
  assert.ok(record && isPidAlive(record.pid), 'setup must leave a running server');
  const result = await withServerLock(ctx, () => stopServer(ctx, { force: true, confirmedByUser: true, lockHeld: true }));
  assert.equal(result.stopped, true, JSON.stringify(result));
  assert.equal(isPidAlive(record.pid), false);
});
