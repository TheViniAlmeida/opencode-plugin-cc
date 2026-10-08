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

test('docs describe the F7 behaviour', () => {
  assert.match(read('docs/commands.md'), /mais recentes/);
  assert.match(read('docs/troubleshooting.md'), /V1_SERVER_ACTIVE/);
  assert.match(read('CHANGELOG.md'), /### Corrigido — F7/);
  assert.doesNotMatch(read('docs/commands.md'), /StructuredOutputError/);
});
