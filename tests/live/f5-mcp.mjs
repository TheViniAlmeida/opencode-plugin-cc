// Provider-backed MCP acceptance; explicit models, disposable plugin state, no global config writes.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { isActive, isTerminal, readJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { cliJson, findJobId, makeTempDir, makeWorkspace, REPO_ROOT, registerStopper, startMcpClient, trackEnv, trackTempDir, writeGlobalConfig } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';

const FIRST = process.env.OPC_LIVE_MODEL?.trim();
const SECOND = process.env.OPC_LIVE_MODEL_2?.trim();
const SKIP = process.env.OPC_LIVE !== '1' ? 'OPC_LIVE!=1'
  : !FIRST || !SECOND || FIRST === SECOND ? 'Informe dois modelos pessoais distintos em OPC_LIVE_MODEL e OPC_LIVE_MODEL_2.' : false;
const REPORT = process.env.OPC_F5_LIVE_REPORT || path.join(REPO_ROOT, 'docs/phases/F5-live-output.md');

test('F5 live: MCP discovery and a two-model conclave match the CLI (three runs, at least two pass)', { skip: SKIP, timeout: 3_600_000 }, async (t) => {
  const cwd = makeWorkspace(t, { git: false, name: 'f5-mcp' });
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f5-mcp-'));
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: cwd });
  for (const key of ['OPC_SERVER_URL', 'OPC_SERVER_PASSWORD', 'OPC_COMPANION_SESSION_ID', 'OPC_COMPANION_TRANSCRIPT_PATH', 'CLAUDE_PLUGIN_DATA']) delete env[key];
  writeGlobalConfig(env, {
    defaultModel: FIRST,
    policy: { providers: { allow: [...new Set([FIRST, SECOND].map((id) => id.split('/')[0]))], deny: ['omniroute-work'] }, models: { allow: [FIRST, SECOND], deny: [] }, agents: { deny: ['work-*'] } },
    conclave: { memberTimeoutSec: 300 },
  });
  const safe = (value) => {
    let output = safeOutputText(String(value), dataDir).split(cwd).join('<workspace>');
    for (const [index, model] of [FIRST, SECOND].entries()) output = output.split(model).join(`<model-${index + 1}>`);
    for (const provider of new Set([FIRST, SECOND].map((model) => model.split('/')[0]))) output = output.split(provider).join('<provider>');
    return output;
  };
  const client = startMcpClient({ env, cwd, timeoutMs: 660_000 });
  registerStopper(t, () => client.close());
  const init = await client.initialize();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [...TOOL_NAMES]);
  const models = await client.callTool('opc_models', { allowed: true });
  const cliModels = await cliJson(['models', '--allowed'], { env, cwd, timeoutMs: 120_000 });
  assert.equal(models.envelope.exitCode, 0, safe(JSON.stringify(models.envelope.error)));
  assert.equal(cliModels.code, 0, safe(cliModels.stderr));
  assert.deepEqual(models.envelope.data, cliModels.data);
  const runs = [];
  const stateDir = workspaceStateDir(dataDir, cwd);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let jobId;
    try {
      const started = await client.callTool('opc_conclave', {
        question: 'Should a CLI print progress to stderr or stdout? Give a concise position and rationale. Do not use tools.',
        models: [FIRST, SECOND], quorum: 2, rounds: 1, judge: 'claude',
      });
      assert.equal(started.envelope.exitCode, 0, safe(JSON.stringify(started.envelope.error)));
      jobId = findJobId(started.envelope.data, 'conc');
      assert.ok(jobId, 'Conclave returned a group ID.');
      const status = await client.callTool('opc_job_status', { jobId, wait: true, timeoutSec: 540 });
      assert.equal(status.envelope.exitCode, 0, safe(JSON.stringify(status.envelope.error)));
      const result = await client.callTool('opc_job_result', { jobId });
      const cli = await cliJson(['result', jobId], { env, cwd });
      assert.equal(result.envelope.exitCode, 0, safe(JSON.stringify(result.envelope.error)));
      assert.equal(cli.code, 0, safe(cli.stderr));
      assert.deepEqual(result.envelope.data, cli.data);
      assert.equal(result.envelope.data.group.id, jobId);
      assert.equal(result.envelope.data.members.length, 2);
      assert.equal(result.envelope.data.group.status, 'completed');
      assert.ok(result.envelope.data.members.every((member) => member.status === 'completed'));
      runs.push({ run: attempt + 1, ok: true, jobId, members: 2 });
    } catch (error) {
      runs.push({ run: attempt + 1, ok: false, error: safe(error.message).slice(0, 1000) });
    } finally {
      if (jobId && isActive(readJob(stateDir, jobId))) {
        const cancelled = await client.callTool('opc_job_cancel', { jobId });
        const finishedDuringCancel = cancelled.envelope.error?.code === 'NOT_FOUND' && isTerminal(readJob(stateDir, jobId));
        assert.ok(cancelled.envelope.exitCode === 0 || finishedDuringCancel, safe(JSON.stringify(cancelled.envelope.error)));
      }
    }
  }
  appendSafeOutput(REPORT, `### MCP: descoberta e conclave de dois modelos\n\n\`\`\`json\n${JSON.stringify(runs, null, 2)}\n\`\`\`\n\n`, dataDir);
  t.diagnostic(safe(JSON.stringify(runs)));
  assert.ok(runs.filter((run) => run.ok).length >= 2, safe(JSON.stringify(runs)));
});
