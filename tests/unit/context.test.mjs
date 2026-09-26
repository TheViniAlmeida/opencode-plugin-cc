import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { makeTempDir, makeWorkspace, removeTempDir } from '../helpers.mjs';

function sink() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  stream.text = () => chunks.join('');
  return stream;
}

test('createContext resolves dirs (700), config and redacted output helpers', async (t) => {
  const data = makeTempDir('opc-ctx-');
  t.after(() => removeTempDir(data));
  const ws = makeWorkspace(t, { name: 'ctx ws' });
  const stdout = sink();
  const stderr = sink();
  const ctx = await createContext({ argv: ['--json'], env: { OPC_DATA_DIR: data, OPC_COMPANION_SESSION_ID: 'sess-1', HOME: data }, cwd: ws, stdout, stderr });
  assert.equal(ctx.dataDir, data);
  assert.equal(ctx.workspaceRoot, ws);
  assert.ok(ctx.stateDir.startsWith(path.join(data, 'state', 'ctx-ws-')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(ctx.stateDir).mode & 0o777, 0o700);
  assert.equal(ctx.claudeSessionId, 'sess-1');
  assert.equal(ctx.config.policy.approver, 'user');
  assert.deepEqual(ctx.configWarnings, []);
  assert.deepEqual(ctx.configMeta, { hasGlobal: false, workspaceFound: false });
  const secret = 'ctx-secret-0123456789abc';
  registerSecret(secret);
  ctx.out(`a ${secret}\n`);
  ctx.json({ password: 'x', note: secret });
  ctx.log('progress');
  ctx.err(`e ${secret}\n`);
  assert.equal(stdout.text(), 'a ***\n{\n  "password": "***",\n  "note": "***"\n}\n');
  assert.equal(stderr.text(), '[opc] progress\ne ***\n');
});

test('createContext fails with DATA_DIR_UNRESOLVED unless createDataDir is set', async (t) => {
  const home = makeTempDir('opc-ctx-');
  t.after(() => removeTempDir(home));
  const ws = makeWorkspace(t);
  await assert.rejects(createContext({ env: { HOME: home }, cwd: ws }), (e) => e.code === 'DATA_DIR_UNRESOLVED');
  const ctx = await createContext({ env: { HOME: home }, cwd: ws, createDataDir: true });
  assert.equal(ctx.dataDir, path.join(home, '.claude', 'plugins', 'data', 'opc-opencode-plugin-cc'));
  assert.ok(fs.existsSync(ctx.stateDir));
});
