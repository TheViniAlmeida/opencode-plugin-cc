import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('F7 report records every live fact and the gate rows', () => {
  const live = read('docs/phases/F7-live-output.md');
  for (const key of ['P1-precedence', 'P2-children-cursor', 'P3-fork', 'P4-model-updated', 'I1-compaction', 'I2-pending-revert']) assert.match(live, new RegExp(`\`${key}\``));
  assert.doesNotMatch(live, /omniroute-(?!personal)[a-z]/);
  const report = read('docs/phases/F7-report.md');
  assert.match(report, /\| Suíte completa \|.*\| PASSOU \|/);
  assert.match(report, /\| `npm run scan-secrets` \|.*\| PASSOU \|/);
});

test('F7 report does not claim live evidence it does not have', () => {
  const report = read('docs/phases/F7-report.md');
  assert.match(report, /\| Espera do catálogo em attach[^\n]*\| NÃO VALIDADO \|/);
  assert.match(report, /\| Substituição de um servidor registrado anterior à 2\.0\.22[^\n]*\| NÃO VALIDADO \|/);
  assert.match(report, /NÃO VALIDADO ao vivo: a espera do catálogo em attach/);
  assert.match(report, /NÃO VALIDADO ao vivo: a substituição de um servidor registrado anterior à 2\.0\.22/);
  assert.match(report, /A CONFIRMAR: a forma V2 de `enabled_providers` e `disabled_providers`/);
  assert.match(read('docs/phases/F6-report.md'), /NÃO VALIDADO ao vivo em attach/);
  assert.doesNotMatch(read('docs/troubleshooting.md'), /o opc espera o evento `model\.updated`|mais 2 s por providers faltantes/);
});

test('docs describe the F7 behaviour', () => {
  assert.match(read('docs/commands.md'), /mais recentes/);
  assert.match(read('docs/troubleshooting.md'), /V1_SERVER_ACTIVE/);
  assert.match(read('docs/troubleshooting.md'), /Comandos falham com `TIMEOUT` em attach/);
  assert.match(read('CHANGELOG.md'), /### Corrigido — F7/);
  assert.doesNotMatch(read('docs/commands.md'), /StructuredOutputError/);
});
