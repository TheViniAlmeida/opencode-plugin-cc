import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { PLUGIN_ROOT, REPO_ROOT } from '../helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('documentação pública descreve somente OpenCode V2', () => {
  const files = ['README.md', 'docs/architecture.md', 'docs/commands.md', 'docs/troubleshooting.md', 'docs/permissions.md', 'docs/configuration.md'];
  for (const file of files) {
    const doc = read(REPO_ROOT, file);
    assert.doesNotMatch(doc, /opencode attach|\/global\/health|prompt_async|OpenCode 1\.18|session todo/i, file);
  }
  const readme = read(REPO_ROOT, 'README.md');
  assert.match(readme, /OpenCode ≥ 2\.0\.22/);
  assert.match(readme, /server\.opencodeBin/);
  assert.match(readme, /OPC_OPENCODE_BIN/);
  assert.match(read(REPO_ROOT, 'docs', 'commands.md'), /24 ferramentas `opc_\*`/);
});

test('arquitetura documenta o MCP e todas as ferramentas atuais', () => {
  const doc = read(REPO_ROOT, 'docs', 'architecture.md');
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
