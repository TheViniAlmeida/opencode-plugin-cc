import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter present');
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }));
}

test('/opc:orchestrate is model-invocable and passes arguments through a quoted heredoc', () => {
  const text = read('plugins/opc/commands/orchestrate.md');
  const fm = frontmatter(text);
  assert.ok(fm.description.length > 20);
  assert.match(fm['argument-hint'], /--synthesizer claude\|<modelo>/);
  assert.equal(fm['disable-model-invocation'], undefined, 'model may invoke /opc:orchestrate');
  assert.match(fm['allowed-tools'], /Bash\(opc:\*\)/);
  assert.ok(!/Bash\(\*\)|--dangerously|--no-verify/.test(text));
  assert.ok(text.includes("opc orchestrate --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n$ARGUMENTS\nOPC_ARGS_5f1d0c7a_EOF\n"));
  assert.ok(!text.includes('--args-stdin <<'), 'free text never goes through --args-stdin (shell-like split)');
  for (const code of ['**0**', '**3**', '**6**', '**7**']) assert.ok(text.includes(code), `documents exit ${code}`);
});

test('opc-delegation skill carries the orchestration synthesis guidance', () => {
  const text = read('plugins/opc/skills/opc-delegation/SKILL.md');
  assert.ok(text.includes('## Orquestração (`/opc:orchestrate`)'));
  for (const phrase of ['invalid_plan', 'dependency_failed', 'Síntese a cargo do Claude', 'Arquivos tocados', 'opc-result-handling', "--raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n--\n"]) {
    assert.ok(text.includes(phrase), `mentions ${phrase}`);
  }
  assert.ok(!text.includes('when that command is available'), 'orchestrate is available from F4b on');
});

test('prompt templates exist and use only known placeholders', () => {
  const decompose = read('plugins/opc/prompts/orchestrate-decompose.md');
  const synthesize = read('plugins/opc/prompts/orchestrate-synthesize.md');
  const names = (t) => [...new Set([...t.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names(decompose), ['AGENTS', 'MAX_SUBTASKS', 'PROJECT_CONTEXT', 'TARGET_RANGE', 'TASK', 'WRITE_MODE']);
  assert.deepEqual(names(synthesize), ['RATIONALE', 'RESULTS', 'TASK']);
});
