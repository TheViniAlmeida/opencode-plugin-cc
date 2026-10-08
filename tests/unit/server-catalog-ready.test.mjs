import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/lib/opencode-config.mjs';
import { ensureServer, expectedProviders, waitForModelCatalog } from '../../plugins/opc/scripts/lib/server.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { REPO_ROOT, makeTempDir, trackTempDir } from '../helpers.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const model = (providerID, id = 'm') => ({ providerID, id });

test('expectedProviders honours provider, enabled_providers and disabled_providers', () => {
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {}, c: {} }, disabled_providers: ['b'] }), ['a', 'c']);
  assert.deepEqual(expectedProviders({ provider: { a: {}, b: {} }, enabled_providers: ['b'] }), ['b']);
  assert.deepEqual(expectedProviders({}), []);
});

test('expectedProviders reads the V2 plural key and falls back to the V1 singular one', () => {
  assert.deepEqual(expectedProviders({ providers: { a: {}, b: {} }, disabled_providers: ['b'] }), ['a']);
  assert.deepEqual(expectedProviders({ providers: { v2: {} }, provider: { v1: {} } }), ['v2']);
  assert.deepEqual(expectedProviders({ provider: { v1: {} } }), ['v1']);
});

test('expectedProviders finds the provider declared in the live V2 config fixtures', () => {
  for (const name of ['config.json', 'config-precedence.json']) {
    const sources = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22', name), 'utf8'));
    assert.deepEqual(expectedProviders(mergeOpencodeConfigSources(sources)), ['omniroute-personal'], name);
  }
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
    if (route === '/api/config') return new Response(JSON.stringify([{ type: 'document', info: { providers: { gateway: {} }, share: 'disabled' } }]));
    assert.equal(route, '/api/model');
    modelCalls += 1;
    return new Response(JSON.stringify(modelCalls < 2 ? [model('opencode')] : [model('opencode'), model('gateway')]));
  });
  const server = await ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' } });
  assert.equal(modelCalls, 2);
  assert.ok(!server.warnings.some((w) => w.includes('sem modelos no catálogo')));
});

test('a bootstrap that settled without the event (stream down) does not hold the wait when no provider is declared', async () => {
  const started = performance.now();
  const result = await waitForModelCatalog({ models: async () => [model('opencode')] },
    { bootstrap: Promise.resolve(false), bootstrapTimeoutMs: 30_000, pollMs: 1, expected: [] });
  assert.deepEqual(result.missing, []);
  assert.ok(performance.now() - started < 1000, 'waited on a bootstrap that already settled');
});

test('settleMs bounds the wait for missing providers once the catalog is non-empty', async () => {
  const started = performance.now();
  const result = await waitForModelCatalog({ models: async () => [model('opencode')] },
    { timeoutMs: 5_000, pollMs: 5, settleMs: 40, expected: ['gateway'] });
  assert.deepEqual(result.missing, ['gateway']);
  assert.ok(performance.now() - started < 1000, 'ran to the timeout instead of the settle window');
});

test('settleMs does not cut the wait while the catalog is still empty', async () => {
  let calls = 0;
  const api = { models: async () => { calls += 1; return calls < 6 ? [] : [model('opencode'), model('gateway')]; } };
  const result = await waitForModelCatalog(api, { timeoutMs: 5_000, pollMs: 20, settleMs: 10, expected: ['gateway'] });
  assert.deepEqual(result.missing, []);
  assert.equal(calls, 6);
});

test('a catalog request that times out at the deadline after a non-empty poll returns the last catalog with missing providers', async () => {
  let calls = 0;
  const api = { models: async () => {
    calls += 1;
    if (calls === 1) return [model('opencode')];
    await new Promise((resolve) => setTimeout(resolve, 70));
    throw new ConnectionError('TIMEOUT', 'request timed out');
  } };
  const result = await waitForModelCatalog(api, { timeoutMs: 50, pollMs: 1, expected: ['gateway'] });
  assert.deepEqual(result.missing, ['gateway']);
  assert.equal(result.models.length, 1);
});

test('the timeout error states the cap and the next step', async () => {
  await assert.rejects(waitForModelCatalog({ models: async () => [] }, { timeoutMs: 30, pollMs: 5 }),
    (err) => err.code === 'TIMEOUT' && /não carregou em \d+ s/.test(err.message) && /confira os providers/.test(err.message));
});

test('attach reports a declared provider that never loads in warnings after the settle window', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-attach-missing-'));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return new Response(JSON.stringify(loadContractSample('info.json')));
    if (route === '/api/config') return new Response(JSON.stringify([{ type: 'document', info: { providers: { ghost: {} }, share: 'disabled' } }]));
    assert.equal(route, '/api/model');
    return new Response(JSON.stringify([model('opencode')]));
  });
  const started = performance.now();
  const server = await ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' } });
  assert.ok(server.warnings.some((w) => w.includes('sem modelos no catálogo') && w.includes('ghost')));
  assert.ok(performance.now() - started < 10_000, 'attach ran to the 15 s cap instead of the settle window');
});
