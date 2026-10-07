import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';

import { testEnv } from '../helpers.mjs';
import { fixtureModelIds, makeMainRepo, promptBodies, sessionCreateBodies, writeGlobalConfig } from '../f2b-helpers.mjs';
import { REVIEW_OK_STRUCTURED } from '../fixtures/scenarios/review-ok.mjs';
import { createContext } from '../../plugins/opc/scripts/lib/context.mjs';
import { parseFullId } from '../../plugins/opc/scripts/lib/models.mjs';
import { newJobId, submitTurnJob, turnJobRequest, waitForJob } from '../../plugins/opc/scripts/lib/jobs.mjs';

function quietContext(env, cwd) {
  return createContext({ argv: [], env, cwd, stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
}

test('F2a job ids use review and gate prefixes (spec §9.1)', () => {
  assert.match(newJobId('review'), /^review-/);
  assert.match(newJobId('stop-gate'), /^gate-/);
});

test('F2a task-worker honors the F2b turn request (format, read-only profile, model, result)', async (t) => {
  const cwd = makeMainRepo(t);
  const env = testEnv(t, { scenario: 'review-ok', extra: { OPC_COMPANION_SESSION_ID: 'contract-session' } });
  const [full] = fixtureModelIds();
  writeGlobalConfig(env, { defaultModel: full, review: { structuredOutput: 'tool' } });
  const ctx = await quietContext(env, cwd);
  const model = parseFullId(full);
  const format = { type: 'json_schema', schema: { type: 'object' } };
  const request = turnJobRequest({
    kind: 'review', profile: 'read-only', prompt: 'CONTRACT_PROMPT_MARKER', model, modelFull: full,
    format, timeoutMs: 60000, title: 'OPC: review: contract', config: ctx.config,
    extra: { review: { variant: 'review', targetLabel: 'contract target', inputMode: 'inline-diff', focus: '' } },
  });
  assert.equal(request.profileKind, 'read-only');
  assert.equal(request.childPermission, null);
  const job = await submitTurnJob(ctx, { kind: 'review', title: request.title, summary: 'contract', request, queuedLog: 'Revisão enfileirada (contrato).' });
  assert.match(job.id, /^review-/);
  assert.equal(job.claudeSessionId, 'contract-session');
  assert.equal(job.permissionProfile, 'read-only');
  assert.equal(job.model, full);
  const done = await waitForJob(ctx, job.id, { waitTimeoutMs: 60000 });
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.deepEqual(done.result.structured, REVIEW_OK_STRUCTURED);
  assert.equal(typeof done.result.finalText, 'string');
  assert.equal(done.request.review.targetLabel, 'contract target');
  const [session] = sessionCreateBodies(env);
  assert.match(session.title, /^OPC: /);
  assert.deepEqual(session.permissions[0], { action: '*', resource: '*', effect: 'deny' });
  assert.equal(session.permissions.some((rule) => rule.action === 'shell' && rule.effect === 'allow'), false);
  assert.deepEqual(session.model, { providerID: model.providerID, id: model.modelID });
  const [prompt] = promptBodies(env);
  assert.equal(Object.hasOwn(prompt, 'format'), false, 'OpenCode 2 has no json_schema output');
  assert.equal(Object.hasOwn(prompt, 'model'), false, 'the prompt does not carry the model');
  assert.match(prompt.text, /CONTRACT_PROMPT_MARKER/);
  assert.match(prompt.text, /Reply with only one JSON object/);
  assert.equal(prompt.id, request.messageID);
  assert.match(prompt.id, /^msg/);
});
