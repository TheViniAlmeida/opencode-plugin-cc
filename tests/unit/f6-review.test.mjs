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
  assert.match(read('plugins/opc/scripts/commands/transfer.mjs'), /resumeCommand: (?:passwordFrom === null \? null : )?`cd .*--server/);
});

test('F6 report records the live gate and keeps manual checks pending', () => {
  const report = read('docs/phases/F6-report.md');
  assert.match(report, /Contrato V2 ao vivo.*\| PASSOU \|/);
  assert.match(report, /Serves do operador antes\/depois.*\| PASSOU \|/);
  assert.match(report, /TUI:.*\| NÃO VALIDADO \|/);
  const live = read('docs/phases/F6-live-output.md');
  for (const file of ['contract-v2.mjs', 'f2a-jobs.mjs', 'f2b-review.mjs', 'f3-subagents.mjs', 'f4c-opinion.mjs', 'f5-mcp.mjs', 'f5-transfer.mjs']) {
    assert.match(live, new RegExp(`${file.replace('.', '\\.')}\` \\| PASSOU`), file);
  }
  for (const text of [report, live]) {
    for (const provider of text.match(/omniroute-[A-Za-z0-9]+/g) ?? []) assert.match(provider, /^omniroute-(personal|work)$/);
  }
});
