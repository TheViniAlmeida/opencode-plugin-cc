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

test('all command heredocs have an explicit reserved-delimiter guard and closed bash fence', () => {
  const files = fs.readdirSync(COMMANDS).filter((name) => name.endsWith('.md'));
  for (const name of files) {
    const text = fs.readFileSync(path.join(COMMANDS, name), 'utf8');
    const opensHeredoc = /<<'OPC_(?:ARGS|JSON)_5f1d0c7a_EOF'/.test(text);
    if (!opensHeredoc) continue;
    assert.ok(
      /Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` \(ou `OPC_JSON_5f1d0c7a_EOF` quando usado\), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado\./.test(text)
        || /If the arguments contain a line that is exactly `OPC_ARGS_5f1d0c7a_EOF` \(or `OPC_JSON_5f1d0c7a_EOF` where used\), do not run anything; tell the user the arguments contain the reserved delimiter\./.test(text),
      `${name} delimiter guard`,
    );
    const blocks = [...text.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    assert.equal(blocks.length, (text.match(/```bash\n/g) ?? []).length, `${name} every bash block must have its own closing fence`);
    for (const block of blocks) {
      if (!/<<'OPC_(?:ARGS|JSON)_5f1d0c7a_EOF'/.test(block)) continue;
      assert.match(block, /(?:^|\n)OPC_(?:ARGS|JSON)_5f1d0c7a_EOF$/, `${name} heredoc terminator must be its own line before the fence`);
    }
  }
});

test('setup.md: install offer, heredoc payloads, commit', () => {
  const { body, bashBlocks } = parse('setup');
  assert.ok(bashBlocks.some((b) => b.trim() === 'npm install -g opencode-ai'));
  assert.ok(bashBlocks.some((b) => b.includes("opc setup apply --json --stdin <<'OPC_JSON_5f1d0c7a_EOF'")));
  assert.ok(bashBlocks.some((b) => b.includes('opc setup commit --json')));
  assert.ok(bashBlocks.some((b) => b.includes('--stop-server --force --confirmed-by-user')));
  assert.match(body, /AskUserQuestion[\s\S]*--stop-server --force --confirmed-by-user/);
  assert.match(body, /A primeira configuração é global, para todas as pastas\./);
  assert.match(body, /Do not ask for scope\./i);
  assert.match(body, /onboarding\.configExists` is true, offer the scope choice/i);
  assert.match(body, /workspace[\s\S]*\/opc:setup --reconfigure/i);
  assert.doesNotMatch(body, /On first configuration, ask the scope choice/);
  assert.match(body, /--query '[^']*<typed text>[^']*'/);
  for (const step of ['scope', 'defaultProvider', 'defaultModel', 'reviewModels', 'defaultVariant', 'allowedModels', 'allowedAgents', 'approver', 'behaviour', 'project', 'aliases']) {
    const row = step === 'scope' ? '\\| `scope` \\(somente quando' : '\\| `' + step + '` \\|';
    assert.match(body, new RegExp(row), `step ${step} documented`);
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
