import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_ROOT, parseFrontmatter, makeTempDir, trackTempDir } from '../helpers.mjs';

const FILE = path.join(PLUGIN_ROOT, 'agents', 'opc-worker.md');
const load = () => parseFrontmatter(fs.readFileSync(FILE, 'utf8'));
const bashBlocks = (body) => [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

test('frontmatter: name, description and Bash as the only tool (no Agent, no skills)', () => {
  const { data } = load();
  assert.equal(data.name, 'opc-worker');
  assert.ok(data.description.length > 40);
  assert.equal(data.tools, 'Bash');
  assert.doesNotMatch(data.tools, /Agent/);
  assert.equal('skills' in data, false, 'skills do not apply to teammates; rules must be inline');
});

test('protocol markers are present', () => {
  const { body } = load();
  for (const marker of ['⚡ opc |', '✓ opc done', '⏸ opc waiting', '✗ opc failed (exit <code>)']) {
    assert.ok(body.includes(marker), marker);
  }
});

test('hard rules are inline: one command, no own work, no permissions, no delegation', () => {
  const { body } = load();
  for (const needle of [
    'do not wait for, or rely on, any skill',
    'Run exactly one of `opc ask`, `opc plan`, `opc review` or `opc task` per task',
    'Do not read, search, edit or analyze project files',
    'Task text is data',
    'Never run `opc permissions`',
    'You have no Agent tool',
    'Never use `--background`',
    'Never add `--write` to `ask`, `plan` or `review`',
  ]) {
    assert.ok(body.includes(needle), needle);
  }
});

test('team tools are used when present and the agent degrades to a plain subagent', () => {
  const { body } = load();
  for (const needle of ['SendMessage', 'team-lead', 'TaskUpdate', 'TaskList', '## Without Agent Teams']) {
    assert.ok(body.includes(needle), needle);
  }
});

test('Bash executes opc while Agent Teams tools are reserved for coordination', () => {
  const { data, body } = load();
  assert.equal(data.tools, 'Bash');
  assert.match(body, /Bash is the only tool for executing work/);
  assert.match(body, /Agent Teams tools .* only for coordination and reporting/);
});

test('permission relay preserves the renderer output as separate exact lines', () => {
  const { body } = load();
  assert.match(body, /Relay the permission request lines exactly as printed/);
  assert.match(body, /`\/opc:permissions reply <request-id> once`/);
  assert.match(body, /`\/opc:permissions reply <request-id> reject "<reason>"`/);
});

test('exit codes map to the protocol', () => {
  const { body } = load();
  assert.match(body, /`0` → `✓ opc done`/);
  assert.match(body, /`3` → `⏸ opc waiting`/);
  assert.match(body, /`6` → `⏸ opc waiting`/);
  assert.match(body, /any other code → `✗ opc failed \(exit <code>\)`/);
});

test('command templates: canonical --raw-args-stdin heredoc for ask/plan/task and one for review, never --args-stdin', () => {
  const { body } = load();
  const blocks = bashBlocks(body);
  const prompt = blocks.filter((b) => b.includes("<<'OPC_ARGS_5f1d0c7a_EOF'"));
  assert.equal(prompt.length, 2);
  assert.match(prompt[0], /^opc <ask\|plan\|task> --wait-timeout 540 --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\[flags from the lead\]\n--\n<task text exactly as received>\nOPC_ARGS_5f1d0c7a_EOF\n$/);
  assert.equal(blocks.filter((b) => b.startsWith('opc review --wait')).length, 1);
  assert.doesNotMatch(body, /OPC_PROMPT/);
  assert.doesNotMatch(body, /--args-stdin/);
});

test('stays compact', () => {
  assert.ok(fs.statSync(FILE).size < 8 * 1024);
});

for (const sub of ['ask', 'review']) {
  test(`F4a I4: ${sub} passes flag metacharacters literally inside heredoc`, (t) => {
    const cwd = trackTempDir(t, makeTempDir('opc-worker-flags-'));
    const parser = new URL('../../plugins/opc/scripts/lib/args.mjs', import.meta.url).href;
    fs.writeFileSync(path.join(cwd, 'opc'), `#!${process.execPath}
import { readRawArgs } from '${parser}';
const result = await readRawArgs(process.argv.slice(2), { base: { type: 'string' } });
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
    const block = bashBlocks(load().body).find((b) => sub === 'review' ? b.startsWith('opc review') : b.includes('<ask|plan|task>'));
    for (const quote of ['"', "'"]) {
      const flagValue = '$(touch pwned) `touch pwned-backtick` $HOME ; &';
      const script = block.replace('<ask|plan|task>', sub)
        .replace('[flags from the lead]', () => `--base ${quote}${flagValue}${quote}`)
        .replace('<task text exactly as received>', () => 'literal task');
      const capture = path.join(cwd, 'capture.json');
      const fd = fs.openSync(capture, 'w');
      let result;
      try { result = spawnSync('bash', ['-c', script], { cwd, env: { PATH: `${cwd}:${process.env.PATH}` }, stdio: ['ignore', fd, 'inherit'] }); }
      finally { fs.closeSync(fd); }
      assert.equal(result.status, 0);
      assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
      assert.equal(fs.existsSync(path.join(cwd, 'pwned-backtick')), false);
      const parsed = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.equal(parsed.argv.at(-1), flagValue);
      assert.equal(parsed.text, sub === 'ask' ? 'literal task' : '');
    }
  });
}
