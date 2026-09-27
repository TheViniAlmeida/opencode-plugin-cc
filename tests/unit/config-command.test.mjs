import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../../plugins/opc/scripts/commands/config.mjs';
import { loadConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import {
  makeTempDir, trackTempDir, writeGlobalConfig, scriptedTTY, captureStream,
} from '../helpers.mjs';

test('offline policy edit reaches POLICY_DENIED and preserves both config files', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-config-command-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-config-workspace-'));
  const file = writeGlobalConfig({ OPC_DATA_DIR: dataDir }, { defaultModel: 'blocked/model' });
  const before = fs.readFileSync(file, 'utf8');
  const stderr = captureStream();
  const ctx = {
    dataDir, workspaceRoot, stdin: scriptedTTY(['policy.providers.deny']), stderr,
    err: (text) => stderr.write(text),
  };
  Object.defineProperty(ctx, 'config', { get() { assert.fail('offline edit must not connect to a server'); } });

  await assert.rejects(run(ctx, ['add', 'policy.providers.deny', 'blocked', '--workspace', '--tty-confirm']), (err) => {
    assert.equal(err.exitCode, 4);
    assert.equal(err.code, 'POLICY_DENIED');
    assert.match(err.message, /policy\.providers\.deny: blocked/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadConfig({ dataDir, workspaceRoot }).workspace, null);
});
