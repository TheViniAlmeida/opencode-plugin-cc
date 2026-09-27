import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../../plugins/opc/scripts/commands/config.mjs';
import { main } from '../../plugins/opc/scripts/opc-companion.mjs';
import { loadConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import {
  makeTempDir, trackTempDir, writeGlobalConfig, scriptedTTY, captureStream, pipedStdin,
} from '../helpers.mjs';

test('locked-key JSON output never contains the raw value without a TTY', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-config-command-'));
  const cwd = trackTempDir(t, makeTempDir('opc-config-workspace-'));
  const raw = 'FAKE-SECRET-VALUE-123456';
  for (const flags of [[], ['--tty-confirm']]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await main(['config', 'set', 'policy.models.deny', raw, '--json', ...flags], {
      env: { OPC_DATA_DIR: dataDir }, cwd, stdin: pipedStdin(), stdout, stderr,
    });
    assert.equal(code, 4);
    const output = JSON.parse(stdout.text());
    assert.equal(output.error.code, 'LOCKED_KEY');
    assert.equal(output.error.details.command, "opc config set policy.models.deny '<valor>' --tty-confirm");
    assert.equal((stdout.text() + stderr.text()).includes(raw), false);
  }
});

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
