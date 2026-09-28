import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, opc, requestsTo, setupF2a } from '../helpers.mjs';

const HOSTILE = `fix "it" don't \`touch pwned-backtick\` $(touch pwned) \${HOME} $PATH ção 日本語 🚀\nsecond line \\ with backslash; rm -rf / && echo nope | cat`;

function assertNothingExecuted(cwd) {
  for (const name of ['pwned', 'pwned-backtick']) {
    assert.equal(existsSync(join(cwd, name)), false, `${name} must not exist in the workspace`);
    assert.equal(existsSync(join(process.cwd(), name)), false, `${name} must not exist in the test cwd`);
  }
}

function runCommandMarkdown(ctx, commandFile, userArguments) {
  const markdown = readFileSync(join(PLUGIN_ROOT, 'commands', commandFile), 'utf8');
  const block = /```bash\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  if (!block) throw new Error(`${commandFile} must contain a closed bash block`);
  const script = block.replace('$ARGUMENTS', () => userArguments);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { cwd: ctx.cwd, env: { ...ctx.env, PATH: `${join(PLUGIN_ROOT, 'bin')}:${ctx.env.PATH}` } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('prompt-roundtrip: the /opc:task heredoc delivers the text verbatim and nothing executes', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await runCommandMarkdown(ctx, 'task.md', HOSTILE);
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.equal(prompt.body.parts[0].text, HOSTILE);
  assertNothingExecuted(ctx.cwd);
});

test('prompt-roundtrip: --prompt-file bytes arrive intact', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  writeFileSync(join(ctx.cwd, 'prompt.txt'), `${HOSTILE}\n\ttrailing tab line\n`);
  const r = await opc(ctx, ['task', '--prompt-file', 'prompt.txt']);
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.equal(prompt.body.parts[0].text, `${HOSTILE}\n\ttrailing tab line\n`);
  assertNothingExecuted(ctx.cwd);
});

test('prompt-roundtrip: ask template keeps $& and $1 literally', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  const r = await opc(ctx, ['ask', '--raw-args-stdin'], { stdin: 'what does $& and $1 and $$ mean here?' });
  assert.equal(r.code, 0, r.stderr);
  const [prompt] = requestsTo(ctx.env, 'POST', /\/prompt_async$/);
  assert.match(prompt.body.parts[0].text, /Question:\nwhat does \$& and \$1 and \$\$ mean here\?/);
});
