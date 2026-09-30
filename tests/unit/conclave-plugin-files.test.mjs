import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/opc');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'file starts with YAML frontmatter');
  return Object.fromEntries(m[1].split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
}

test('/opc:conclave is model-invocable and passes arguments through a quoted heredoc', () => {
  const text = read('commands', 'conclave.md');
  const fm = frontmatter(text);
  assert.ok(fm.description);
  assert.match(fm['argument-hint'], /--mode opinion\|review\|debate/);
  assert.match(fm['argument-hint'], /--allow-judge-member/);
  assert.match(fm['allowed-tools'], /Bash\(opc:\*\)/);
  assert.equal(fm['disable-model-invocation'], undefined);
  assert.match(text, /opc conclave --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n\$ARGUMENTS\nOPC_ARGS/);
  assert.match(text, /opc-conclave/);
  assert.doesNotMatch(text, /opc conclave \$ARGUMENTS/);
});

test('opc-conclave skill covers the synthesis parts and forbids brand bias', () => {
  const text = read('skills', 'opc-conclave', 'SKILL.md');
  const fm = frontmatter(text);
  assert.equal(fm.name, 'opc-conclave');
  assert.ok(fm.description.length > 40);
  for (const heading of ['Consenso', 'Divergências', 'Posição ponderada', 'Recomendação', 'Relatórios minoritários', 'Composição']) {
    assert.ok(text.includes(heading), `skill mentions ${heading}`);
  }
  assert.match(text, /Nunca dê mais ou menos peso a uma resposta por causa do modelo, do vendor ou do provider/);
  assert.match(text, /confidence/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /Não corrija nada/);
  assert.doesNotMatch(text, /deepseek|qwen|kimi|gpt|gemini|anthropic|openai/i);
});
