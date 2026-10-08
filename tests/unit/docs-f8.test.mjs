import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('F8 live output records every live fact and stays sanitized', () => {
  const live = read('docs/phases/F8-live-output.md');
  for (const key of ['attachCatalog', 'attachResume', 'P1-bare-session-model', 'item3-patch-permissions', 'item1-session-rules']) assert.match(live, new RegExp(`"${key}"`));
  assert.doesNotMatch(live, /omniroute-(?!personal)[a-z]/);
  assert.doesNotMatch(live, /\/home\/|\/storage\//);
});

test('F8 report exists with the gate table', () => {
  const report = read('docs/phases/F8-report.md');
  assert.match(report, /\| Item \| Evidência \| Resultado \|/);
  assert.match(report, /\| Suíte completa \|/);
  assert.match(report, /\| `npm run scan-secrets` \|/);
  assert.match(report, /\| Claude Code headless/);
  assert.doesNotMatch(report, /omniroute-(?!personal)[a-z]/);
  assert.doesNotMatch(report, /\/home\/|\/storage\//);
});

test('docs describe the F8 behaviour', () => {
  assert.match(read('CHANGELOG.md'), /### Corrigido — F8/);
  assert.match(read('docs/troubleshooting.md'), /disabled_providers/);
  assert.match(read('docs/phases/F7-report.md'), /Atualização F8/);
  assert.match(read('docs/superpowers/plans/2026-09-26-opc-CHECKLIST.md'), /README em inglês para publicação \(F8/);
});
