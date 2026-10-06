import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { PLUGIN_ROOT, REPO_ROOT } from '../helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('architecture.md documents the MCP server and every tool', () => {
  const doc = read(REPO_ROOT, 'docs', 'architecture.md');
  assert.match(doc, /^## Servidor MCP \(F5\)$/m);
  for (const name of TOOL_NAMES) assert.ok(doc.includes(`\`${name}\``), name);
  assert.match(doc, /2025-06-18/);
  assert.doesNotMatch(doc, /`opc_question_answer`/);
});

test('commands.md documents /opc:transfer with its exit codes and the MCP tools', () => {
  const doc = read(REPO_ROOT, 'docs', 'commands.md');
  assert.match(doc, /^## `\/opc:transfer`$/m);
  for (const code of ['TRANSCRIPT_OUTSIDE_ALLOWED_ROOT', 'NO_MODEL', 'IMPORT_FAILED', 'OPC_TRANSFER_ALLOWED_ROOT']) {
    assert.ok(doc.includes(code), code);
  }
  assert.match(doc, /^### Ferramentas MCP$/m);
});

test('README and troubleshooting mention MCP; the skill carries the MCP rules', () => {
  assert.match(read(REPO_ROOT, 'README.md'), /^## Servidor MCP$/m);
  assert.match(read(REPO_ROOT, 'docs', 'troubleshooting.md'), /^## MCP e transfer$/m);
  const skill = read(PLUGIN_ROOT, 'skills', 'opc-result-handling', 'SKILL.md');
  assert.match(skill, /^## Ferramentas MCP \(`opc_\*`\)$/m);
  assert.match(skill, /confirmedByUser/);
});
