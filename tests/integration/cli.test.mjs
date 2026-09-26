import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PLUGIN_BIN_DIR, makeWorkspace, parseJsonOutput, runCli, testEnv } from '../helpers.mjs';

test('no subcommand and unknown subcommands exit 2 with a rendered error', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const none = await runCli([], { env, cwd: ws });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /# opc error\nUSAGE: Uso: opc <subcomando>/);
  const unknown = await runCli(['nope', '--json'], { env, cwd: ws });
  assert.equal(unknown.code, 2);
  assert.equal(parseJsonOutput(unknown.stdout).error.code, 'USAGE');
  const traversal = await runCli(['../lib/state'], { env, cwd: ws });
  assert.equal(traversal.code, 2);
});

test('unknown flags exit 2', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const res = await runCli(['setup', '--bogus'], { env, cwd: ws });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Flag desconhecida: --bogus/);
});

test('bin/opc runs the companion through sh', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  assert.ok(fs.statSync(path.join(PLUGIN_BIN_DIR, 'opc')).mode & 0o111, 'bin/opc must be executable');
  const res = await runProcess('sh', ['-c', 'opc setup --json'], { env: { ...env, PATH: `${PLUGIN_BIN_DIR}${path.delimiter}${env.PATH}` }, cwd: ws });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(parseJsonOutput(res.stdout).server.status, 'running');
});

test('heredoc --args-stdin never expands $() or backticks (slash command invocation)', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t);
  const commandDoc = fs.readFileSync(new URL('../../plugins/opc/commands/setup.md', import.meta.url), 'utf8');
  const delimiter = commandDoc.match(/<<'([^']+)'/)?.[1];
  assert.ok(delimiter, 'setup command must quote its heredoc delimiter');
  const script = [
    `opc setup --json --args-stdin <<'${delimiter}'`,
    'OPC_ARGS',
    'touch pwned',
    '$(touch pwned-dollar) `touch pwned-backtick` "$(touch pwned-quoted)"',
    delimiter,
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { env: { ...env, PATH: `${PLUGIN_BIN_DIR}${path.delimiter}${env.PATH}` }, cwd: ws, stdio: 'ignore' });
  assert.equal(res.status, 2, res.error?.message);
  for (const f of ['pwned', 'pwned-dollar', 'pwned-backtick', 'pwned-quoted']) assert.equal(fs.existsSync(path.join(ws, f)), false, f);
  assert.equal((commandDoc.match(/<<'OPC_ARGS_5f1d0c7a_EOF'/g) ?? []).length, 2);
});

test('--args-stdin feeds flags from stdin and --cwd selects the workspace', async (t) => {
  const env = testEnv(t);
  const ws = makeWorkspace(t, { name: 'target ws' });
  const other = makeWorkspace(t, { name: 'other' });
  const res = await runCli(['setup', '--args-stdin'], { env, cwd: other, stdin: `--json --cwd "${ws}"\n` });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(parseJsonOutput(res.stdout).workspaceRoot, ws);
});
