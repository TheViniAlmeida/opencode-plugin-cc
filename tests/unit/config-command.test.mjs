import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as configCommand from '../../plugins/opc/scripts/commands/config.mjs';
import { run } from '../../plugins/opc/scripts/commands/config.mjs';
import { main } from '../../plugins/opc/scripts/opc-companion.mjs';
import { loadConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import {
  makeTempDir, trackTempDir, writeGlobalConfig, scriptedTTY, captureStream, pipedStdin,
} from '../helpers.mjs';

for (const source of ['ancestor', 'environment']) {
  test(`--tty-confirm refuses Claude Code ${source} before creating a prompter`, async () => {
    const stderr = captureStream();
    const ctx = {
      env: source === 'environment' ? { CLAUDECODE: '1' } : {},
      stdin: scriptedTTY(['policy.approver']), stderr, err: (text) => stderr.write(text),
    };
    await assert.rejects(configCommand.confirmLocked(ctx, { 'tty-confirm': true }, {
      op: 'set', key: 'policy.approver', raw: 'synthetic-value', scope: 'global',
    }, {
      hasClaudeAncestor: () => source === 'ancestor',
      createPrompter: () => assert.fail('Claude Code must be refused before prompting'),
    }), (err) => {
      assert.equal(err.code, 'LOCKED_KEY');
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /Claude Code.*terminal próprio/);
      assert.equal(err.details.command, "opc config set policy.approver '<valor>' --tty-confirm");
      assert.equal(JSON.stringify(err).includes('synthetic-value'), false);
      return true;
    });
    assert.equal(stderr.text(), '');
  });
}

test('--tty-confirm still requires the exact key in a standalone terminal', async () => {
  for (const [typed, accepted] of [['policy.approver', true], ['wrong.setting', false]]) {
    let closed = false;
    const ctx = { env: {}, stdin: { isTTY: true }, err: () => {} };
    const deps = {
      hasClaudeAncestor: () => false,
      createPrompter: () => ({ text: async () => typed, close: () => { closed = true; } }),
    };
    const result = configCommand.confirmLocked(ctx, { 'tty-confirm': true }, {
      op: 'unset', key: 'policy.approver', scope: 'global',
    }, deps);
    if (accepted) await result;
    else await assert.rejects(result, (err) => err.code === 'LOCKED_KEY');
    assert.equal(closed, true);
  }
});

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
    dataDir, workspaceRoot, env: {}, stdin: scriptedTTY(['policy.providers.deny']), stderr,
    err: (text) => stderr.write(text),
  };
  Object.defineProperty(ctx, 'config', { get() { assert.fail('offline edit must not connect to a server'); } });

  await assert.rejects(run(ctx, ['add', 'policy.providers.deny', 'blocked', '--workspace', '--tty-confirm'], { hasClaudeAncestor: () => false }), (err) => {
    assert.equal(err.exitCode, 4);
    assert.equal(err.code, 'POLICY_DENIED');
    assert.match(err.message, /policy\.providers\.deny: blocked/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadConfig({ dataDir, workspaceRoot }).workspace, null);
});
