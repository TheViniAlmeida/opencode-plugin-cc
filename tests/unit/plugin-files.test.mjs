import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from '../helpers.mjs';

export function readFrontmatter(rel) {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${rel} must start with YAML frontmatter`);
  const data = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      data[listKey].push(item[1].trim());
      continue;
    }
    const pair = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = value.replace(/^['"]|['"]$/g, '');
      listKey = null;
    }
  }
  return { data, body: match[2] };
}

const tools = (value) => String(value).split(',').map((entry) => entry.trim()).filter(Boolean);

for (const name of ['review', 'adversarial-review']) {
  test(`/opc:${name} is user-only, estimates first and passes arguments through --raw-args-stdin and a quoted heredoc`, () => {
    const { data, body } = readFrontmatter(`commands/${name}.md`);
    assert.equal(data['disable-model-invocation'], 'true');
    assert.deepEqual(tools(data['allowed-tools']), ['Bash(opc:*)', 'Bash(git:*)', 'AskUserQuestion']);
    assert.match(data['argument-hint'], /--wait\|--background/);
    assert.match(body, new RegExp(`opc ${name} --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\\n\\$ARGUMENTS\\nOPC_ARGS`));
    assert.match(body, new RegExp(`opc ${name} --estimate --json --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\\n\\$ARGUMENTS\\nOPC_ARGS`));
    assert.match(body, new RegExp(`opc ${name} --wait --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\\n\\$ARGUMENTS\\nOPC_ARGS`));
    assert.match(body, new RegExp(`opc ${name} --background --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\\n\\$ARGUMENTS\\nOPC_ARGS`));
    assert.doesNotMatch(body, /\s--args-stdin\b/);
    assert.match(body, /AskUserQuestion` exatamente uma vez/);
    assert.match(body, /Aguardar o resultado/);
    assert.match(body, /Rodar em background/);
    assert.match(body, /\(Recomendado\)/);
    assert.match(body, /timeout: 600000/);
    assert.match(body, /Não corrija problemas/);
    assert.match(body, /verbatim/);
    assert.doesNotMatch(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}/);
  });
}

test('/opc:rescue asks continue-or-new through task-resume-candidate and routes to the subagent', () => {
  const { data, body } = readFrontmatter('commands/rescue.md');
  assert.equal(data['disable-model-invocation'], undefined);
  assert.deepEqual(tools(data['allowed-tools']), ['Bash(opc:*)', 'AskUserQuestion', 'Agent']);
  assert.match(body, /subagent_type: "opc:opc-rescue"/);
  assert.match(body, /opc task-resume-candidate --json/);
  assert.match(body, /Continuar a sessão OpenCode atual/);
  assert.match(body, /Começar uma nova sessão OpenCode/);
  assert.match(body, /Não chame `Skill\(opc:opc-rescue\)`/);
  assert.match(body, /`Skill\(opc:rescue\)`/);
  assert.match(body, /verbatim/);
});

test('the opc-rescue agent is a Bash-only forwarder that never replies to permissions', () => {
  const { data, body } = readFrontmatter('agents/opc-rescue.md');
  assert.equal(data.name, 'opc-rescue');
  assert.equal(data.tools, 'Bash');
  assert.deepEqual(data.skills, ['opc-runtime', 'opc-prompting']);
  assert.match(body, /exatamente uma chamada `Bash`/);
  assert.match(body, /opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n--write\n--wait-timeout 540\n<opções de execução, uma por linha>\n--\n<texto da tarefa exatamente como recebido>\nOPC_ARGS/);
  assert.doesNotMatch(body, /OPC_PROMPT/);
  assert.match(body, /Nunca responda a pedidos de permissão/);
  assert.match(body, /primeiras linhas de stderr[\s\S]*nenhum resultado do OpenCode foi produzido/);
  assert.match(body, /exatamente como está/);
  assert.doesNotMatch(body, /\bAgent\b tool/);
});

for (const name of ['opc-runtime', 'opc-result-handling', 'opc-prompting']) {
  test(`skill ${name} has internal-only frontmatter`, () => {
    const { data, body } = readFrontmatter(`skills/${name}/SKILL.md`);
    assert.equal(data.name, name);
    assert.ok(data.description && data.description.length > 20);
    assert.equal(data['user-invocable'], 'false');
    assert.ok(body.trim().length > 500, `${name} has real content`);
  });
}

test('opc-runtime pins the single-task forwarding contract', () => {
  const { body } = readFrontmatter('skills/opc-runtime/SKILL.md');
  assert.match(body, /opc task --raw-args-stdin <<'OPC_ARGS_5f1d0c7a_EOF'\n<opções de execução, uma por linha>\n--wait-timeout 540\n--\n<texto da tarefa exatamente como recebido>\nOPC_ARGS/);
  assert.doesNotMatch(body, /OPC_PROMPT/);
  assert.match(body, /exatamente uma invocação de `task`/);
  assert.match(body, /Nunca execute `opc permissions reply`/);
  assert.match(body, /`--resume`.*`--resume-last`/);
});

test('opc-result-handling enforces stop-and-ask, approver rules and confirmations', () => {
  const { body } = readFrontmatter('skills/opc-result-handling/SKILL.md');
  assert.match(body, /após apresentar os achados da revisão, PARE/);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /Aprovador `user`/);
  assert.match(body, /Aprovador `claude`/);
  assert.match(body, /external_directory/);
  assert.match(body, /sensitivePaths/);
  assert.match(body, /Nunca responda `always`/);
  assert.match(body, /--confirmed-by-user/);
  assert.match(body, /revert/);
  assert.match(body, /--stop-server --force/);
  assert.match(body, /Nenhum achado relevante\./);
  assert.match(body, /Exige o usuário: sim/);
  assert.match(body, /Nunca responda `always`/);
  assert.match(body, /procedimento único de permissões e perguntas/);
  assert.match(body, /não force a parada por conta própria/);
  assert.match(body, /Só quando o usuário pediu `--force`/);
  assert.match(body, /mostre literalmente a lista de jobs ativos impressa/);
  assert.match(body, /somente após confirmação explícita.*--stop-server --force --confirmed-by-user/s);
  assert.doesNotMatch(body, /Sem `--force`, uma recusa por jobs ativos é final/);
});

test('opc-prompting is original guidance for OpenCode models', () => {
  const { body } = readFrontmatter('skills/opc-prompting/SKILL.md');
  assert.match(body, /OpenCode/);
  assert.match(body, /--resume-last/);
  assert.doesNotMatch(body, /GPT-5|Codex/);
  assert.match(body, /Prompts enviados ao OpenCode devem ser escritos em inglês/);
  assert.match(body, /Todo texto fornecido pelo usuário.*passado literalmente no idioma original/);
  assert.match(body, /Goal: <one sentence describing the desired outcome>/);
  assert.match(body, /Use `--write` somente quando o usuário pedir edições; pedidos de planejamento, análise e revisão nunca usam `--write`/);
});

test('opc-runtime and opc-prompting use the same write-mode rule', () => {
  const { body: runtime } = readFrontmatter('skills/opc-runtime/SKILL.md');
  const { body: prompting } = readFrontmatter('skills/opc-prompting/SKILL.md');
  const rule = 'Use `--write` somente quando o usuário pedir edições; pedidos de planejamento, análise e revisão nunca usam `--write`';
  assert.ok(runtime.includes(rule));
  assert.ok(prompting.includes(rule));
});

test('setup command diagnoses active jobs before asking to force-stop', () => {
  const { body } = readFrontmatter('commands/setup.md');
  assert.match(body, /Do not escalate to a forced stop on your own/);
  assert.match(body, /With `--force` in the arguments/);
  assert.match(body, /refuses with exit code `2`/);
  assert.match(body, /show that list verbatim/);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /opc setup --stop-server --force --confirmed-by-user/);
});
