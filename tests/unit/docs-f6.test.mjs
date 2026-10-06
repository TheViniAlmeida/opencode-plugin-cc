import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { PLUGIN_ROOT, REPO_ROOT } from '../helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

// Docs publicados atuais: histórico (docs/phases, docs/superpowers) e CHANGELOG ficam de fora.
function currentDocs() {
  const list = (dir, filter) => fs.readdirSync(dir, { withFileTypes: true }).filter(filter).map((entry) => path.join(dir, entry.name));
  const isMd = (entry) => entry.isFile() && entry.name.endsWith('.md');
  const skills = list(path.join(PLUGIN_ROOT, 'skills'), (entry) => entry.isDirectory()).map((dir) => path.join(dir, 'SKILL.md')).filter((file) => fs.existsSync(file));
  return [
    path.join(REPO_ROOT, 'README.md'),
    ...list(path.join(REPO_ROOT, 'docs'), isMd),
    ...list(path.join(PLUGIN_ROOT, 'commands'), isMd),
    ...skills,
  ];
}

const V1_RESIDUE = [
  [/opencode attach/i, 'opencode attach'],
  [/\/global\/health/i, '/global/health'],
  [/prompt_async/i, 'prompt_async'],
  [/session todo/i, 'session todo'],
  [/OpenCode 1\.18/i, 'OpenCode 1.18'],
  [/1\.18/, 'versão 1.18'],
  [/--part\b/, '--part'],
  [/diff[^\n]*--message/, 'diff --message'],
  [/--message[^\n]*diff/i, '--message ... diff'],
  [/fork\s+(?:ses_|<?sessionID)\S*\s+\[?(?:msg_|<?messageID)/, 'fork com messageID posicional'],
  [/per-message/, 'per-message'],
  [/messagesUnavailable/, 'messagesUnavailable'],
  [/format:\s*`?json_schema/, 'format: json_schema'],
  [/Envia `format: json_schema`/, 'modo tool com json_schema'],
  [/modo `tool`|em `tool`|\| `tool` \|/, 'modo tool ativo'],
  [/opencode import\s*</, 'opencode import <'],
  [/npm install -g opencode-ai/, 'npm install -g opencode-ai'],
];

test('docs publicados atuais não descrevem OpenCode V1 nem comportamento removido', () => {
  const files = currentDocs();
  assert.ok(files.length >= 30, `esperava varrer os docs atuais, achou ${files.length}`);
  for (const file of files) {
    const doc = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of V1_RESIDUE) {
      assert.ok(!pattern.test(doc), `${path.relative(REPO_ROOT, file)}: resto de V1 (${label})`);
    }
  }
});

test('documentação pública descreve somente OpenCode V2', () => {
  const readme = read(REPO_ROOT, 'README.md');
  assert.match(readme, /OpenCode ≥ 2\.0\.22/);
  assert.match(readme, /server\.opencodeBin/);
  assert.match(readme, /OPC_OPENCODE_BIN/);
  assert.match(read(REPO_ROOT, 'docs', 'installation.md'), /OpenCode \| 2\.0\.22 ou mais novo/);
  assert.match(read(REPO_ROOT, 'docs', 'commands.md'), /24 ferramentas `opc_\*`/);
});

test('arquitetura documenta o MCP e todas as ferramentas atuais', () => {
  const doc = read(REPO_ROOT, 'docs', 'architecture.md');
  assert.equal(TOOL_NAMES.length, 24);
  assert.match(doc, /^## Servidor MCP \(F5\)$/m);
  for (const name of TOOL_NAMES) assert.ok(doc.includes(`\`${name}\``), name);
  assert.match(doc, /2025-06-18/);
  assert.doesNotMatch(doc, /`opc_question_answer`|`opc_session_todo`/);
});

test('comandos e skill preservam documentação MCP e transfer', () => {
  const commands = read(REPO_ROOT, 'docs', 'commands.md');
  assert.match(commands, /^## `\/opc:transfer`$/m);
  for (const code of ['TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', 'NO_MODEL', 'IMPORT_FAILED', 'OPC_TRANSFER_ALLOWED_ROOT']) assert.ok(commands.includes(code), code);
  assert.match(commands, /^### Ferramentas MCP$/m);
  assert.match(read(REPO_ROOT, 'README.md'), /^## Servidor MCP$/m);
  assert.match(read(REPO_ROOT, 'docs', 'troubleshooting.md'), /^## MCP e transfer$/m);
  const skill = read(PLUGIN_ROOT, 'skills', 'opc-result-handling', 'SKILL.md');
  assert.match(skill, /^## Ferramentas MCP \(`opc_\*`\)$/m);
  assert.match(skill, /confirmedByUser/);
});
