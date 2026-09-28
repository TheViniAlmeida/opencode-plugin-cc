import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../helpers.mjs';
import { fixtureModelIds } from '../f2b-helpers.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { buildCatalog, parseFullId } from '../../plugins/opc/scripts/lib/models.mjs';
import { resolveTurnModel } from '../../plugins/opc/scripts/lib/routing.mjs';

const PROVIDERS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'provider.json'), 'utf8'));
const api = { providers: async () => PROVIDERS, getConfig: async () => ({}) };

function configWith(patch) {
  return { ...structuredClone(DEFAULT_CONFIG), ...patch };
}

test('resolveTurnModel prefers reviewModel for kind review', async (t) => {
  const ids = fixtureModelIds();
  if (ids.length < 2) return t.skip('fixture has a single model');
  const result = await resolveTurnModel({ api, kind: 'review', config: configWith({ defaultModel: ids[0], reviewModel: ids[1] }) });
  assert.equal(result.full, ids[1]);
  const expected = parseFullId(ids[1]);
  assert.deepEqual(result.model, { providerID: expected.providerID, modelID: expected.modelID });
  assert.ok(Array.isArray(result.warnings));
});

test('resolveTurnModel falls back to defaultModel for the stop gate', async () => {
  const [first] = fixtureModelIds();
  const result = await resolveTurnModel({ api, kind: 'stop-gate', config: configWith({ defaultModel: first, stopGate: { enabled: true, model: null } }) });
  assert.equal(result.full, first);
  assert.equal(result.variant, null);
});

test('an explicit --model wins over reviewModel', async (t) => {
  const ids = fixtureModelIds();
  if (ids.length < 2) return t.skip('fixture has a single model');
  const result = await resolveTurnModel({ api, kind: 'review', flags: { model: ids[0] }, config: configWith({ reviewModel: ids[1] }) });
  assert.equal(result.full, ids[0]);
});

test('an unknown variant is refused with the F1 UNKNOWN_VARIANT usage error', async () => {
  const [first] = fixtureModelIds();
  await assert.rejects(
    resolveTurnModel({ api, kind: 'review', flags: { variant: 'no-such-variant' }, config: configWith({ defaultModel: first }) }),
    (err) => err.code === 'UNKNOWN_VARIANT' && err.exitCode === 2 && /a variante "no-such-vari…" não é válida para /.test(err.message),
  );
});

test('resolveTurnModel exposes the resolution, catalog and OpenCode config for later routing', async () => {
  const [first] = fixtureModelIds();
  const result = await resolveTurnModel({ api, kind: 'review', config: configWith({ defaultModel: first }) });
  assert.equal(result.resolution.candidates[0].full, first);
  assert.ok(result.catalog.byFull.has(first));
  assert.deepEqual(result.opencodeConfig, {});
});

test('a valid variant is passed through', async (t) => {
  const catalog = buildCatalog(PROVIDERS);
  const withVariant = catalog.models.find((model) => catalog.connected.has(model.providerID) && model.variants.length > 0);
  if (!withVariant) return t.skip('fixture has no model with variants');
  const result = await resolveTurnModel({ api, kind: 'review', flags: { model: withVariant.full, variant: withVariant.variants[0] }, config: configWith({}) });
  assert.equal(result.variant, withVariant.variants[0]);
});

test('a denied single-value model exits with the policy code', async () => {
  const [first] = fixtureModelIds();
  const policy = { ...structuredClone(DEFAULT_CONFIG.policy), models: { allow: [], deny: [first] } };
  await assert.rejects(
    resolveTurnModel({ api, kind: 'review', flags: { model: first }, config: configWith({ policy }) }),
    (err) => err.code === 'POLICY_DENIED' && err.exitCode === 4,
  );
});
