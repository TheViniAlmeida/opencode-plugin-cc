import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { F2A_MODEL_ID, F2A_PROVIDER, makeTempDir, trackTempDir } from '../helpers.mjs';

// Precondition of every F2a integration test: the V2 model catalog exposes the selected variant.
test('fixture /api/model has the F2a model with variant "high"', async (t) => {
  const password = 'f2a-fixture-password-000000';
  const fake = await startFake({ port: 0, password, scenario: 'ok', stateFile: join(trackTempDir(t, makeTempDir()), 'state.json') });
  t.after(() => fake.close());
  const res = await fetch(`${fake.url}/api/model`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const body = await res.json();
  const model = body.data.find((item) => item.providerID === F2A_PROVIDER && item.modelID === F2A_MODEL_ID);
  assert.ok(model, 'model present');
  assert.ok(model.variants.some((variant) => variant.id === 'high'), 'variant high present');
});
