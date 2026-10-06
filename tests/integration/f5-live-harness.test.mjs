// Runs the provider-backed live harness against fixtures, including its completed-job cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { safeOutputText } from '../../plugins/opc/scripts/lib/redact.mjs';
import { makeWorkspace, REPO_ROOT, runProcess, testEnv } from '../helpers.mjs';

test('F5 MCP acceptance harness completes all three fixture runs without cancelling terminal groups', { timeout: 120_000 }, async (t) => {
  const cwd = makeWorkspace(t, { git: false });
  const report = path.join(cwd, 'fixture-report.md');
  const env = testEnv(t, { scenario: 'conclave-opinion', extra: {
    OPC_LIVE: '1',
    OPC_LIVE_MODEL: 'omniroute-personal/opencode-go/deepseek-v4.1-flash',
    OPC_LIVE_MODEL_2: 'omniroute-personal/opencode-go/qwen3.8-max',
    OPC_F6_LIVE_REPORT: report,
  } });
  // A nested test runner must start a fresh harness rather than inherit its parent's IPC context.
  delete env.NODE_TEST_CONTEXT;
  const result = await runProcess(process.execPath, ['--test', '--test-reporter=tap', path.join(REPO_ROOT, 'tests/live/f5-mcp.mjs')], { env, cwd, timeoutMs: 110_000 });
  assert.equal(result.code, 0, safeOutputText(result.stdout + result.stderr));
  assert.match(result.stdout, /# skipped 0/, safeOutputText(result.stdout + result.stderr));
  const output = fs.readFileSync(report, 'utf8');
  const runs = JSON.parse(output.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((run) => run.ok && run.members === 2));
  assert.match(result.stdout, /# pass 1/);
});
