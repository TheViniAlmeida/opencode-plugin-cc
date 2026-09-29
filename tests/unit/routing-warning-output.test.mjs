import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { resolveCandidates, routingFields } from '../../plugins/opc/scripts/lib/routing.mjs';
import { createJob, runJobTurn, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { followJob } from '../../plugins/opc/scripts/commands/task.mjs';

const providerID = 'omniroute-personal';
const denied = `${providerID}/cmd/long-provider/long-denied-model-name`;
const unknown = `${providerID}/cmd/long-provider/long-unknown-model-name`;
const catalog = buildCatalog({ connected: [providerID], all: [{ id: providerID, models: {
  denied: { id: denied.slice(providerID.length + 1) }, good: { id: 'good' },
} }] });
const config = {
  routing: { tasks: { ask: [denied, unknown, `${providerID}/good`] } },
  policy: { models: { deny: [denied] } },
};

for (const model of [denied, unknown]) {
  test(`F4a I6: route warning keeps full ${model === denied ? 'denied' : 'unknown'} id`, () => {
    const { warnings } = resolveCandidates({ kind: 'ask', config, catalog });
    const warning = warnings[model === denied ? 0 : 1];
    assert.ok(warning.startsWith(`ignorado ${model}:`), warning);
    assert.ok(warning.includes(model === denied ? `modelo ${model} negado` : `modelo desconhecido "${model}"`), warning);
    if (model === denied) assert.ok(warning.includes(`policy.models.deny: ${denied}`), warning);
  });
}

test('F4a I6: each foreground skip warning appears only once after following the worker', async (t) => {
  const stateDir = trackTempDir(t, makeTempDir('opc-warning-output-'));
  const resolution = resolveCandidates({ kind: 'ask', config, catalog });
  let stderr = '';
  const ctx = { stateDir, err: (s) => { stderr += s; }, out() {} };
  for (const warning of resolution.warnings) ctx.err(`[opc] aviso: ${warning}\n`);
  const request = { model: resolution.candidates[0], ...routingFields(resolution, { warningsReported: true }) };
  const job = await createJob(stateDir, { kind: 'ask', request });
  await runJobTurn({ stateDir, job, baseTurnRequest: request,
    runTurnImpl: async () => ({ status: 'completed', sessionID: 'ses_good' }),
  });
  await updateJob(stateDir, job.id, { status: 'completed' });
  await followJob(ctx, job.id, { waitTimeoutMs: 100 });
  const lines = stderr.split('\n').filter((line) => line.startsWith('[opc] aviso: ignorado '));
  assert.equal(lines.length, 2, stderr);
  for (const id of [denied, unknown]) assert.equal(lines.filter((line) => line.includes(id)).length, 1, stderr);
});
