import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'opc', 'commands');
const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'opc', 'agents');
const F1 = {
  setup: { tools: ['Bash(opc:*)', 'AskUserQuestion'], disableModel: false },
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

function findUnsafeOpcCommandLine(markdown) {
  const bashBlocks = [...markdown.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const unsafe = /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]*\}|\$\(|`|\{\{[^}]*\}\}|<[^>]*>/;
  for (const block of bashBlocks) {
    let heredocTerminator = null;
    for (const line of block.split('\n')) {
      if (heredocTerminator) {
        if (line === heredocTerminator) heredocTerminator = null;
        continue;
      }
      if (!/^\s*opc\s/.test(line)) continue;
      const heredoc = line.match(/<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
      // Check the whole line except the heredoc operator itself (text after it is still shell).
      const commandLine = (heredoc ? line.slice(0, heredoc.index) + line.slice(heredoc.index + heredoc[0].length) : line)
        .replace('opc <ask|plan|task>', 'opc ask');
      if (unsafe.test(commandLine)) return line;
      if (heredoc) heredocTerminator = heredoc[1];
    }
  }
  return null;
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

test('setup.md: install guidance without a package manager, heredoc payloads, commit', () => {
  const { body, bashBlocks } = parse('setup');
  // npm's opencode-ai is still V1; setup only points to the official install and server.opencodeBin.
  assert.ok(!bashBlocks.some((b) => /\bnpm\b/.test(b)));
  assert.match(body, /OpenCode 2\.0\.22 or newer[\s\S]*server\.opencodeBin/);
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

test('command and agent opc invocations keep user supplied values inside quoted heredocs', () => {
  for (const dir of [COMMANDS, AGENTS]) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.equal(findUnsafeOpcCommandLine(text), null, `${name} has no shell expansion or placeholder on an opc command line`);
    }
  }
});

test('command-line lint rejects shell expansions and placeholders in memory fixtures', () => {
  for (const form of ['$NAME', '${NAME}', '"$NAME"', "'$NAME'", '$ARGUMENTS', '{{value}}', '<user value>', '`command`', '$(command)']) {
    const fixture = `\`\`\`bash\nopc review --focus ${form}\n\`\`\``;
    assert.ok(findUnsafeOpcCommandLine(fixture), `${form} is rejected`);
  }
  for (const form of ['--model "$NAME"', "--model '$NAME'", '${NAME}', '$(command)']) {
    const after = `\`\`\`bash\nopc review --raw-args-stdin <<'ARGS' ${form}\n$ARGUMENTS\nARGS\n\`\`\``;
    assert.ok(findUnsafeOpcCommandLine(after), `${form} after the heredoc operator is rejected`);
  }
  const heredocFixture = "```bash\nopc review --raw-args-stdin <<'ARGS'\n$ARGUMENTS\nARGS\n```";
  assert.equal(findUnsafeOpcCommandLine(heredocFixture), null, 'heredoc body remains allowed');
});

test('agent heredocs have the reserved-delimiter guard and standalone terminators', () => {
  for (const name of fs.readdirSync(AGENTS).filter((entry) => entry.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(AGENTS, name), 'utf8');
    if (!/<<'OPC_(?:ARGS|JSON)_5f1d0c7a_EOF'/.test(text)) continue;
    assert.match(text, /Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` \(ou `OPC_JSON_5f1d0c7a_EOF` quando usado\), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado\./, `${name} reserved-delimiter guard`);
    const block = [...text.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((value) => /<<'OPC_/.test(value));
    assert.ok(block, `${name} has a fenced heredoc example`);
    assert.match(block, /(?:^|\n)OPC_ARGS_5f1d0c7a_EOF$/, `${name} heredoc terminator is alone on its line`);
  }
});

test('opc-rescue routes every runtime flag and task text through the raw args heredoc and diagnoses empty failures', () => {
  const rescue = fs.readFileSync(path.join(AGENTS, 'opc-rescue.md'), 'utf8');
  assert.match(rescue, /opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n--write\n--wait-timeout 540\n<opções de execução, uma por linha>\n--\n<texto da tarefa exatamente como recebido>\nOPC_ARGS_5f1d0c7a_EOF/);
  assert.match(rescue, /Se os argumentos contiverem uma linha exatamente igual a `OPC_ARGS_5f1d0c7a_EOF` \(ou `OPC_JSON_5f1d0c7a_EOF` quando usado\), não execute nada; informe ao usuário que os argumentos contêm o delimitador reservado\./);
  assert.match(rescue, /terminador deve ficar sozinho em sua linha/i);
  assert.match(rescue, /código de saída[\s\S]*primeiras linhas de stderr[\s\S]*nenhum resultado do OpenCode foi produzido/i);
  assert.doesNotMatch(rescue, /return nothing/);
});

test('review commands share a byte-identical estimate/choose/execute flow', () => {
  function sharedFlow(name) {
    const text = fs.readFileSync(path.join(COMMANDS, `${name}.md`), 'utf8');
    const match = text.match(/<!-- shared:review-flow -->\n([\s\S]*?)\n<!-- \/shared:review-flow -->/);
    assert.ok(match, `${name}.md has shared review flow markers`);
    return match[1].replaceAll('opc adversarial-review', 'opc review');
  }
  assert.equal(sharedFlow('review'), sharedFlow('adversarial-review'));
  for (const name of ['review', 'adversarial-review']) {
    const text = fs.readFileSync(path.join(COMMANDS, `${name}.md`), 'utf8');
    const match = text.match(/<!-- shared:review-flow -->\n([\s\S]*?)\n<!-- \/shared:review-flow -->/);
    assert.match(match[1], /--estimate --json/);
    assert.match(match[1], /AskUserQuestion/);
    assert.match(match[1], /--background/);
    assert.match(match[1], /--wait/);
  }
});
