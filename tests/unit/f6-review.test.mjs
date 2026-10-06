import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PROBES, EVENT_TYPES } from '../fixtures/contract-shapes.mjs';
import { REPO_ROOT } from '../helpers.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

test('scheduled live contract probes only V2 API routes and events', () => {
  assert.ok(PROBES.length > 0);
  for (const probe of PROBES) assert.match(probe.path, /^\/api\//, probe.name);
  assert.deepEqual(EVENT_TYPES, ['server.connected']);
  const runner = read('tests/live/contract.mjs');
  assert.match(runner, /\['id', 'type', 'data'\]/);
});

test('legacy live probes use V2 sessions, prompts and routes', () => {
  for (const file of ['tests/live/f2a-probes.mjs', 'tests/live/probe-permission-precedence.mjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /prompt_async|client\.post\('\/session|client\.get\('\/config'|client\.get\('\/mcp'|`\/permission\/|\.info\.role|\.info\?\.role|parentID === messageID|\{ permission: '[^']+', pattern:/, file);
    assert.match(source, /permissions/);
    assert.match(source, /model/);
  }
});

test('published transfer instructions select the managed V2 server', () => {
  for (const file of ['docs/commands.md', 'docs/troubleshooting.md', 'plugins/opc/commands/transfer.md']) {
    const source = read(file);
    assert.doesNotMatch(source, /opencode -s <id>|opencode -s ses_EXAMPLE|opencode import <arquivo>/, file);
    assert.match(source, /opencode --server/);
  }
  assert.match(read('plugins/opc/scripts/commands/transfer.mjs'), /resumeCommand: `cd .*opencode --server/);
});

test('F6 report distinguishes controller full-suite result from pending live gate', () => {
  const report = read('docs/phases/F6-report.md');
  assert.match(report, /rodada 2.*GATE: FAIL.*5 falhas/is);
  assert.match(report, /NÃO VALIDADO/);
  const live = read('docs/phases/F6-live-output.md');
  assert.match(live, /NÃO VALIDADO/);
});
