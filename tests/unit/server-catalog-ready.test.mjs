import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureServer, expectedProviders, waitForModelCatalog } from '../../plugins/opc/scripts/lib/server.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const model = (providerID, id = 'm') => ({ providerID, id });

test('expectedProviders honours provider, enabled_providers and disabled_providers', () => {
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {}, c: {} }, disabled_providers: ['b'] }), ['a', 'c']);
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {} }, enabled_providers: ['b'] }), ['b']);
  assert.deepEqual(expectedProviders({}), []);
});

test('catalog is ready as soon as every declared provider is listed, without waiting for model.updated', async () => {
  let calls = 0;
  const api = { models: async () => { calls += 1; return calls < 3 ? [model('opencode')] : [model('opencode'), model('gateway')]; } };
  const started = performance.now();
  const result = await waitForModelCatalog(api, { bootstrap: new Promise(() => {}), bootstrapTimeoutMs: 30_000, pollMs: 1, expected: ['gateway'] });
  assert.deepEqual(result.missing, []);
  assert.equal(calls, 3);
  assert.ok(performance.now() - started < 1000, 'did not wait for the bootstrap deadline');
});

test('a declared provider that never loads ends the wait at the deadline with missing providers', async () => {
  const api = { models: async () => [model('opencode')] };
  const result = await waitForModelCatalog(api, { timeoutMs: 50, pollMs: 5, expected: ['gateway'] });
  assert.deepEqual(result.missing, ['gateway']);
  assert.equal(result.models.length, 1);
});

test('without declared providers and without a bootstrap stream the first non-empty catalog is ready', async () => {
  const result = await waitForModelCatalog({ models: async () => [model('opencode')] }, { pollMs: 1, expected: [] });
  assert.deepEqual(result.missing, []);
});

test('without declared providers the managed boot still waits for model.updated (F6 behaviour)', async () => {
  let announce;
  const bootstrap = new Promise((resolve) => { announce = resolve; });
  let settled = false;
  const pending = waitForModelCatalog({ models: async () => [model('opencode')] }, { bootstrap, bootstrapTimeoutMs: 5_000, pollMs: 1, expected: [] })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'returned before model.updated with no declared provider to check');
  announce(true);
  assert.deepEqual((await pending).missing, []);
});

test('attach waits for the declared providers to appear in the catalog without relying on SSE', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-catalog-'));
  let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return new Response(JSON.stringify(loadContractSample('info.json')));
    if (route === '/api/config') return new Response(JSON.stringify([{ type: 'document', info: { provider: { gateway: {} }, share: 'disabled' } }]));
    assert.equal(route, '/api/model');
    modelCalls += 1;
    return new Response(JSON.stringify(modelCalls < 2 ? [model('opencode')] : [model('opencode'), model('gateway')]));
  });
  const server = await ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' } });
  assert.equal(modelCalls, 2);
  assert.ok(!server.warnings.some((w) => w.includes('sem modelos no catálogo')));
});
