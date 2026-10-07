// Risk 2 of the V2 assessment: GET /api/model/default never becomes the execution model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_MODEL, F2A_MODEL_ID, F2A_PROVIDER, opc, requestsTo, setupF2a } from '../helpers.mjs';
import { SERVER_DEFAULT } from '../fixtures/scenarios/server-default-only.mjs';

test('task without an opc or OpenCode-declared model refuses with NO_MODEL instead of the server default', async (t) => {
  const ctx = setupF2a(t, { scenario: 'server-default-only', config: { defaultProvider: null, defaultModel: null } });
  const models = await opc(ctx, ['models', '--json']);
  assert.equal(models.code, 0, models.stderr);
  const free = JSON.parse(models.stdout).models.find((m) => m.full === `${SERVER_DEFAULT.providerID}/${SERVER_DEFAULT.modelID}`);
  assert.ok(free, 'the server default is a connected catalog model');
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'say hello\n' });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /NO_MODEL/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SERVER_DEFAULT.modelID));
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
});

test('task falls back to the model declared in the OpenCode config sources', async (t) => {
  const ctx = setupF2a(t, {
    scenario: 'server-default-only',
    config: { defaultProvider: null, defaultModel: null, server: { configOverride: { share: 'disabled', model: F2A_MODEL } } },
  });
  const r = await opc(ctx, ['task', '--raw-args-stdin'], { stdin: 'say hello\n' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [post] = requestsTo(ctx.env, 'POST', '/api/session');
  assert.deepEqual(post.body.model, { providerID: F2A_PROVIDER, id: F2A_MODEL_ID });
});
