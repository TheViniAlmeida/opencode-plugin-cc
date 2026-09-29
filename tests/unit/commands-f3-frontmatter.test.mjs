import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from '../helpers.mjs';

function frontmatter(name) {
  const text = readFileSync(join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name}.md needs a frontmatter block`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^'(.*)'$/, '$1')];
  }));
  return { fields, body: match[2] };
}

const STDIN_FLAG = { sessions: '--args-stdin', session: '--args-stdin', subagent: '--raw-args-stdin', command: '--raw-args-stdin', attach: '--args-stdin' };

for (const name of Object.keys(STDIN_FLAG)) {
  test(`${name}.md: descrição, heredoc e Bash somente do opc`, () => {
    const { fields, body } = frontmatter(name);
    assert.ok(fields.description?.length > 10);
    assert.ok(fields['argument-hint']);
    assert.match(fields['allowed-tools'], /Bash\(opc:\*\)/);
    assert.doesNotMatch(fields['allowed-tools'], /Bash\((node|npm|git|rm|sh)/);
    assert.ok(body.includes(`opc ${name} ${STDIN_FLAG[name]} <<'OPC_ARGS_5f1d0c7a_EOF'\n$ARGUMENTS\nOPC_ARGS_5f1d0c7a_EOF`));
    assert.doesNotMatch(body, /--dangerously|--no-verify/);
  });
}

test('somente attach desativa invocação pelo modelo e permite tmux', () => {
  for (const name of ['sessions', 'session', 'subagent', 'command']) {
    const { fields } = frontmatter(name);
    assert.equal(fields['disable-model-invocation'], undefined, name);
    assert.doesNotMatch(fields['allowed-tools'], /tmux/, name);
  }
  const { fields } = frontmatter('attach');
  assert.equal(fields['disable-model-invocation'], 'true');
  assert.match(fields['allowed-tools'], /Bash\(tmux:\*\)/);
});

test('session.md pede confirmação antes de --confirmed-by-user', () => {
  const { fields, body } = frontmatter('session');
  assert.match(fields['allowed-tools'], /AskUserQuestion/);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /--confirmed-by-user/);
});

test('skill documenta confirmação de revert e grupos', () => {
  const skill = readFileSync(join(PLUGIN_ROOT, 'skills/opc-result-handling/SKILL.md'), 'utf8');
  assert.match(skill, /## Sessões: revert e unrevert/);
  assert.match(skill, /## Grupos de subagentes/);
});
