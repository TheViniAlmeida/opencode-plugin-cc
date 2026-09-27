import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'opc', 'commands');
const F1 = {
  setup: { tools: ['Bash(opc:*)', 'Bash(npm:*)', 'AskUserQuestion'], disableModel: false },
  config: { tools: ['Bash(opc:*)'], disableModel: true },
  providers: { tools: ['Bash(opc:*)'], disableModel: false },
  models: { tools: ['Bash(opc:*)'], disableModel: false },
  agents: { tools: ['Bash(opc:*)'], disableModel: false },
  catalog: { tools: ['Bash(opc:*)'], disableModel: false },
};

function parse(name) {
  const text = fs.readFileSync(path.join(COMMANDS, `${name}.md`), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name}.md has frontmatter`);
  const front = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')];
  }));
  const bashBlocks = [...match[2].matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  return { front, body: match[2], bashBlocks };
}

for (const [name, expected] of Object.entries(F1)) {
  test(`${name}.md: frontmatter and safe invocation`, () => {
    const { front, body, bashBlocks } = parse(name);
    assert.ok(front.description && front.description.length > 10);
    assert.ok(front['argument-hint']);
    const tools = front['allowed-tools'].split(',').map((s) => s.trim());
    assert.deepEqual(tools, expected.tools);
    assert.equal(front['disable-model-invocation'] === 'true', expected.disableModel);
    assert.match(body, /opc \S+ (--json )?--args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS/);
    for (const block of bashBlocks) {
      assert.doesNotMatch(block, /--tty-confirm|--dangerously|--no-verify|\$\(/, `${name}.md bash block is safe`);
      if (block.includes('$ARGUMENTS')) assert.match(block, /<<'OPC_ARGS_5f1d0c7a_EOF'/, 'user arguments only through the quoted heredoc');
    }
  });
}

test('setup.md: install offer, heredoc payloads, commit', () => {
  const { body, bashBlocks } = parse('setup');
  assert.ok(bashBlocks.some((b) => b.trim() === 'npm install -g opencode-ai'));
  assert.ok(bashBlocks.some((b) => b.includes("opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'")));
  assert.ok(bashBlocks.some((b) => b.includes('opc setup commit --json')));
  assert.ok(bashBlocks.some((b) => b.includes('--stop-server --force --confirmed-by-user')));
  assert.match(body, /AskUserQuestion[\s\S]*--stop-server --force --confirmed-by-user/);
  assert.match(body, /AskUserQuestion[\s\S]*scope[\s\S]*opc setup apply/);
  assert.match(body, /--query '[^']*<typed text>[^']*'/);
  for (const step of ['scope', 'defaultProvider', 'defaultModel', 'reviewModels', 'defaultVariant', 'allowedModels', 'allowedAgents', 'approver', 'behaviour', 'project', 'aliases']) {
    assert.match(body, new RegExp('\\| `' + step + '` \\|'), `step ${step} documented`);
  }
});

test('models search quotes a free-text query with spaces as one argument', () => {
  const { body } = parse('setup');
  assert.match(body, /--query 'deepseek v4'/);
});

test('providers output format documents the --json exception', () => {
  const { body } = parse('providers');
  assert.match(body, /Markdown unless `--json` is passed/i);
});
