import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { F2A_MODEL_ID, F2A_PROVIDER, makeTempDir } from '../helpers.mjs';

// Precondition of every F2a integration test: the /provider fixture exposes the model and variant used.
test('fixture /provider has the F2a model connected, with variant "high"', async (t) => {
  const password = 'f2a-fixture-password-000000';
  const fake = await startFake({ port: 0, password, scenario: 'ok', stateFile: join(makeTempDir(), 'state.json') });
  t.after(() => fake.close());
  const res = await fetch(`${fake.url}/provider`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const body = await res.json();
  assert.ok(body.connected.includes(F2A_PROVIDER));
  const provider = body.all.find((p) => p.id === F2A_PROVIDER);
  const model = provider.models[F2A_MODEL_ID];
  assert.ok(model, 'model present');
  assert.ok(Object.keys(model.variants ?? {}).includes('high'), 'variant high present');
});
