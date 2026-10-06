import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../helpers.mjs';
import { fixtureModelIds } from '../f2b-helpers.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { buildCatalog, parseFullId } from '../../plugins/opc/scripts/lib/models.mjs';
import { resolveTurnModel } from '../../plugins/opc/scripts/lib/routing.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const PROVIDERS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'provider.json'), 'utf8'));
const MODELS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'data', 'model.json'), 'utf8'));
const api = { providers: async () => PROVIDERS, models: async () => MODELS, defaultModel: async () => null, getConfigSources: async () => [] };
// V2 2.0.22: GET /api/model/default is the server's catalog pick (a free opencode/* model), not a user choice.
const SERVER_DEFAULT = loadContractSample('model-default.json').data;
const SERVER_DEFAULT_FULL = `${SERVER_DEFAULT.providerID}/${SERVER_DEFAULT.modelID}`;
const apiWithServerDefault = (configSources) => ({
  providers: async () => PROVIDERS,
  models: async () => [...MODELS, SERVER_DEFAULT],
  defaultModel: async () => SERVER_DEFAULT,
  getConfigSources: configSources,
});

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

test('the server default model never becomes the execution fallback (NO_MODEL)', async () => {
  assert.match(SERVER_DEFAULT_FULL, /^opencode\//);
  const sources = async () => [{ type: 'directory', path: '<workspace>' }, { type: 'document', path: '<workspace>/opencode.json', info: { share: 'disabled' } }];
  const fake = apiWithServerDefault(sources);
  // The free model is in the connected catalog and still is not picked.
  const { byFull, connected } = buildCatalog({ providers: await fake.providers(), models: await fake.models() });
  assert.ok(byFull.has(SERVER_DEFAULT_FULL) && connected.has(SERVER_DEFAULT.providerID));
  await assert.rejects(
    resolveTurnModel({ api: fake, kind: 'review', config: configWith({}) }),
    (err) => err.code === 'NO_MODEL' && err.exitCode === 2 && /"model" declarado na configuração do OpenCode/.test(err.message) && !err.message.includes(SERVER_DEFAULT.modelID),
  );
});

test('the model declared in the OpenCode config sources is the opencode fallback', async () => {
  const declared = fixtureModelIds().find((id) => id !== SERVER_DEFAULT_FULL);
  const sources = async () => [
    { type: 'directory', path: '<workspace>' },
    { type: 'document', path: '<global>/opencode.json', info: { model: SERVER_DEFAULT_FULL } },
    { type: 'document', path: '<workspace>/opencode.json', info: { model: declared } },
  ];
  const result = await resolveTurnModel({ api: apiWithServerDefault(sources), kind: 'review', config: configWith({}) });
  assert.equal(result.full, declared);
  assert.equal(result.resolution.candidates[0].source, 'opencode');
  assert.equal(result.opencodeConfig.model, declared);
  // The server default still marks the catalog.
  assert.equal(result.catalog.providers.find((p) => p.id === SERVER_DEFAULT.providerID).defaultModel, SERVER_DEFAULT_FULL);
});

test('a failed GET /api/config leaves no fallback and NO_MODEL says why', async () => {
  const sources = async () => { throw new RequestError('SERVER_ERROR', 'GET /api/config: erro do servidor (500).'); };
  await assert.rejects(
    resolveTurnModel({ api: apiWithServerDefault(sources), kind: 'review', config: configWith({}) }),
    (err) => err.code === 'NO_MODEL' && err.exitCode === 2 && /GET \/api\/config\) não pôde ser lida \(SERVER_ERROR\)/.test(err.message) && !err.message.includes(SERVER_DEFAULT.modelID),
  );
  const [first] = fixtureModelIds();
  const explicit = await resolveTurnModel({ api: apiWithServerDefault(sources), kind: 'review', config: configWith({ defaultModel: first }) });
  assert.equal(explicit.full, first);
});

test('a GET /api/config failure outside the API layer is not swallowed', async () => {
  const sources = async () => { throw new TypeError('bug'); };
  await assert.rejects(resolveTurnModel({ api: apiWithServerDefault(sources), kind: 'review', config: configWith({ defaultModel: fixtureModelIds()[0] }) }), TypeError);
});

test('a valid variant is passed through', async (t) => {
  const catalog = buildCatalog({ providers: PROVIDERS, models: MODELS });
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
