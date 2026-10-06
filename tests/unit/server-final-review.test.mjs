import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { run as setup } from '../../plugins/opc/scripts/commands/setup.mjs';
import { ensureServer, stopServer, assertCanCreateSessions, waitForModelCatalog, watchCatalogBootstrap } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { mergeOpencodeConfigSources } from '../../plugins/opc/scripts/commands/setup.mjs';
import { validateAgainstServer } from '../../plugins/opc/scripts/lib/config.mjs';
import { spawnDetached, terminateProcessGroup, isPidAlive } from '../../plugins/opc/scripts/lib/process.mjs';
import { makeTempDir, registerStopper, trackTempDir } from '../helpers.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

test('onboarding merges V2 config documents in order for defaultVariant validation', () => {
  const opencodeConfig = mergeOpencodeConfigSources([
    { type: 'document', info: { model: 'old/model', share: 'auto' } },
    { type: 'directory', path: '<workspace>' },
    { type: 'document', info: { model: 'current/model', share: 'disabled' } },
  ]);
  assert.deepEqual(opencodeConfig, { model: 'current/model', share: 'disabled' });
  const catalog = { connected: new Set(), byFull: new Map([['current/model', { full: 'current/model', variants: ['high'] }]]) };
  assert.deepEqual(validateAgainstServer({ defaultVariant: 'high' }, { catalog, opencodeConfig }).errors, []);
});

test('model warm-up aborts an individual request at its overall deadline', async () => {
  const client = createClient({ baseUrl: 'http://127.0.0.1:43210', requestTimeoutMs: 30_000,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const started = performance.now();
  await assert.rejects(waitForModelCatalog(createApi(client), { timeoutMs: 25, pollMs: 1 }), { code: 'TIMEOUT' });
  assert.ok(performance.now() - started < 1000);
});

test('model warm-up waits for the bootstrap model.updated before trusting a partial catalog', async () => {
  let calls = 0;
  let loaded = false;
  let announce;
  const bootstrap = new Promise((resolve) => { announce = resolve; });
  const builtIn = { providerID: 'opencode', id: 'built-in' };
  const api = { models: async () => { calls += 1; return loaded ? [builtIn, { providerID: 'gateway', id: 'late' }] : [builtIn]; } };
  const pending = waitForModelCatalog(api, { bootstrap, bootstrapTimeoutMs: 5_000, pollMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, 'catalog read before the bootstrap event');
  loaded = true;
  announce(true);
  assert.equal((await pending).length, 2);
});

test('model warm-up falls back to the non-empty check when the bootstrap event never comes', async () => {
  const started = performance.now();
  const models = await waitForModelCatalog({ models: async () => [{ providerID: 'opencode', id: 'built-in' }] },
    { bootstrap: new Promise(() => {}), bootstrapTimeoutMs: 30, pollMs: 1 });
  assert.equal(models.length, 1);
  assert.ok(performance.now() - started < 1000);
});

test('catalog bootstrap watcher resolves on model.updated and false when the stream fails', async () => {
  const encoder = new TextEncoder();
  const streamOf = (text) => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); } }), { headers: { 'content-type': 'text/event-stream' } });
  const client = createClient({ baseUrl: 'http://127.0.0.1:43210', password: 'pw' });
  const ok = watchCatalogBootstrap(client, { fetchImpl: async () => streamOf('data: {"type":"server.connected","data":{}}\n\ndata: {"type":"model.updated","data":{}}\n\n') });
  assert.equal(await ok.opened, true);
  assert.equal(await ok.ready, true);
  ok.stop();
  const broken = watchCatalogBootstrap(client, { fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal(await broken.opened, false);
  assert.equal(await broken.ready, false);
  broken.stop();
});

test('V2 health rejects old versions and HTML even when HTTP status is 200', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-v2-health-'));
  const ctx = { stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ version: '1.18.34' })));
  await assert.rejects(ensureServer(ctx), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_VERSION');
    assert.equal(error.message, 'OpenCode 1.18.34 é anterior ao mínimo suportado 2.0.22. Instale o OpenCode V2 ou aponte server.opencodeBin (ou OPC_OPENCODE_BIN) para o binário V2.');
    return true;
  });
  globalThis.fetch.mock.mockImplementation(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(ensureServer(ctx), (error) => {
    assert.equal(error.code, 'NOT_JSON');
    return true;
  });
});

test('V2 config documents merge in source order before share check', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-v2-config-'));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return new Response(JSON.stringify(loadContractSample('info.json')));
    assert.equal(route, '/api/config');
    return new Response(JSON.stringify([
      ...loadContractSample('config.json'),
      { type: 'document', info: { share: 'auto' } },
      { type: 'directory', path: '<workspace>' },
      { type: 'document', info: { share: 'disabled' } },
    ]));
  });
  const server = await ensureServer({ stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' } });
  assert.equal(server.world.shareBlocked, false);
});

test('setup onboarding reads V2 catalogs without exposing provider settings', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-v2-setup-'));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return new Response(JSON.stringify(loadContractSample('info.json')));
    if (route === '/api/config') return new Response(JSON.stringify(loadContractSample('config.json')));
    if (route === '/api/provider') return new Response(JSON.stringify(loadContractSample('provider.json')));
    if (route === '/api/model') return new Response(JSON.stringify(loadContractSample('model.json')));
    if (route === '/api/agent') return new Response(JSON.stringify(loadContractSample('agent.json')));
    assert.fail(`Rota inesperada: ${route}`);
  });
  const ctx = { stateDir: dir, workspaceRoot: dir, dataDir: dir, config: {}, configMeta: {}, configWarnings: [],
    env: { OPC_SERVER_URL: 'http://127.0.0.1:43210', PATH: '' } };
  let report;
  assert.equal(await setup({ ...ctx, json(value) { report = value; } }, ['--json']), 0);
  assert.equal(report.onboarding.serverError, null);
  assert.ok(report.onboarding.connectedProviders.length > 0);
  assert.ok(!JSON.stringify(report).includes('apiKey'));
  assert.ok(!JSON.stringify(report).includes('YOUR_API_KEY_HERE'));
});

for (const [scenario, status, body] of [
  ['204', 204, undefined], ['null', 200, null], ['array', 200, []], ['string', 200, 'invalid'],
  ['number', 200, 1], ['unavailable', 503, {}], ['auto', 200, [{ type: 'document', info: { share: 'auto' } }]],
  ['disabled', 200, [{ type: 'document', info: { share: 'disabled' } }]],
]) {
  test(`config ${scenario}: attach and setup fail closed with correct guidance`, async (t) => {
    const dir = trackTempDir(t, makeTempDir('opc-config-review-'));
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (new URL(url).pathname === '/api/info') return new Response(JSON.stringify({ version: '2.0.22' }));
      assert.equal(new URL(url).pathname, '/api/config');
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    });
    const ctx = { stateDir: dir, workspaceRoot: dir, dataDir: dir, config: {},
      configMeta: {}, configWarnings: [], env: { OPC_SERVER_URL: 'http://127.0.0.1:43210', PATH: '' } };
    const server = await ensureServer(ctx);
    const blocked = scenario !== 'disabled';
    assert.equal(server.world.shareBlocked, blocked);
    const reason = scenario === 'auto' ? 'share-auto' : 'config-unavailable';
    if (blocked) {
      assert.equal(server.world.shareReason, reason);
      assert.throws(() => assertCanCreateSessions(server), { code: 'SHARE_AUTO' });
    } else assert.doesNotThrow(() => assertCanCreateSessions(server));
    let report;
    assert.equal(await setup({ ...ctx, json(value) { report = value; } }, ['--json']), blocked ? 4 : 0);
    assert.equal(report.server.sessionsBlocked, blocked ? reason : null);
    if (blocked && scenario !== 'auto') {
      assert.ok(report.nextSteps.some((s) => /configuração.*compartilhamento/.test(s)));
      assert.ok(!report.nextSteps.some((s) => /Desligue o share/.test(s)));
    }
  });
}

for (const password of [undefined, '', 'fake-dispose-password']) {
  test(`stopServer stops an identity-matched child without a usable password (${JSON.stringify(password)})`, async (t) => {
    const dir = trackTempDir(t, makeTempDir('opc-stop-review-'));
    const script = path.join(dir, 'opencode');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const proc = await spawnDetached(process.execPath, [script, 'serve', '--port', '43210'], {
      cwd: dir, env: process.env, logFile: path.join(dir, 'child.log'),
    });
    registerStopper(t, async () => {
      const result = await terminateProcessGroup(proc, (argv) => argv.includes(script), { graceMs: 500 });
      assert.notEqual(result, 'identity-mismatch', 'test child shutdown must be confirmed');
    });
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1,
      ...proc, port: 43210, url: 'http://127.0.0.1:43210', password }));
    let requests = 0;
    t.mock.method(globalThis, 'fetch', () => { requests += 1; throw new Error('unexpected HTTP request'); });
    const recordPath = path.join(dir, 'server.json');
    const record = fs.readFileSync(recordPath, 'utf8');
    fs.writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(record), startTime: `${proc.startTime}-mismatch` }));
    try {
      assert.deepEqual(await stopServer({ stateDir: dir, config: {}, env: {} }), { stopped: false, reason: 'identity-mismatch' });
      assert.equal(isPidAlive(proc.pid), true, 'stop must preserve a process whose identity no longer matches');
      assert.equal(requests, 0);
    } finally {
      fs.writeFileSync(recordPath, record);
    }
    const result = await stopServer({ stateDir: dir, config: {}, env: {} });
    assert.equal(result.stopped, true);
    assert.equal(requests, 0, 'stop must never send dispose, even with a password');
    assert.equal(isPidAlive(proc.pid), false);
    assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  });
}

test('stopServer removes attach.secret when the recorded process has already exited', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-stop-exited-'));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1,
    pid: 2147483000, startTime: 'already-exited', port: 43210, url: 'http://127.0.0.1:43210', password: 'fixture-only' }));
  fs.writeFileSync(path.join(dir, 'attach.secret'), 'fixture-only', { mode: 0o600 });

  assert.deepEqual(await stopServer({ stateDir: dir, config: {}, env: {} }), { stopped: false, reason: 'not-running' });
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'attach.secret')), false);
});

test('stopServer removes attach.secret when the recorded process identity mismatches', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-stop-mismatch-'));
  const script = path.join(dir, 'opencode');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const proc = await spawnDetached(process.execPath, [script, 'serve', '--port', '43210'], {
    cwd: dir, env: process.env, logFile: path.join(dir, 'child.log'),
  });
  registerStopper(t, async () => terminateProcessGroup(proc, (argv) => argv.includes(script), { graceMs: 500 }));
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ schemaVersion: 1,
    ...proc, startTime: `${proc.startTime}-mismatch`, port: 43210, url: 'http://127.0.0.1:43210', password: 'fixture-only' }));
  fs.writeFileSync(path.join(dir, 'attach.secret'), 'fixture-only', { mode: 0o600 });

  assert.deepEqual(await stopServer({ stateDir: dir, config: {}, env: {} }), { stopped: false, reason: 'identity-mismatch' });
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'attach.secret')), false);
});
