import test from 'node:test';
import assert from 'node:assert/strict';
import { connectApi, openApi, surfaceServerWarnings } from '../../plugins/opc/scripts/lib/context.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const model = (providerID, id = 'm') => ({ providerID, id });

// Attach-mode ensureServer against a mocked fetch whose config declares `provider` but whose catalog never lists it.
function attachContext(t, provider, extra = {}) {
  const dir = trackTempDir(t, makeTempDir('opc-warn-surface-'));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return new Response(JSON.stringify(loadContractSample('info.json')));
    if (route === '/api/config') return new Response(JSON.stringify([{ type: 'document', info: { providers: { [provider]: {} }, share: 'disabled' } }]));
    assert.equal(route, '/api/model');
    return new Response(JSON.stringify([model('opencode')]));
  });
  const stderr = [];
  const stdout = [];
  const ctx = {
    stateDir: dir, workspaceRoot: dir, config: {}, env: { OPC_SERVER_URL: 'http://127.0.0.1:43210' },
    err: (text) => stderr.push(text), out: (text) => stdout.push(text), ...extra,
  };
  return { ctx, stderr, stdout };
}

test('connectApi prints the missing-provider warning on stderr and never the static attach line', async (t) => {
  const { ctx, stderr, stdout } = attachContext(t, 'ghost-connect');
  const { server } = await connectApi(ctx);
  assert.ok(server.warnings.some((w) => w.startsWith('Modo attach:')), 'precondition: ensureServer reports the attach line');
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /^\[opc\] aviso: Providers declarados ainda sem modelos no catálogo: ghost-connect\./);
  assert.match(stderr[0], /disabled_providers\/enabled_providers/);
  assert.match(stderr[0], /\n$/);
  assert.doesNotMatch(stderr.join(''), /Modo attach:/);
  assert.deepEqual(stdout, []);
});

test('openApi without respawn (workers) surfaces the same warnings through the context writer', async (t) => {
  const { ctx, stderr, stdout } = attachContext(t, 'ghost-worker');
  await openApi(ctx, { respawn: false });
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /ghost-worker/);
  assert.deepEqual(stdout, []);
});

test('the same warning is printed once per process, however many times the helper runs', () => {
  const lines = [];
  const ctx = { err: (text) => lines.push(text) };
  surfaceServerWarnings(ctx, ['aviso-repetido']);
  surfaceServerWarnings(ctx, ['aviso-repetido', 'aviso-novo']);
  assert.deepEqual(lines, ['[opc] aviso: aviso-repetido\n', '[opc] aviso: aviso-novo\n']);
});

test('surfaceServerWarnings is silent without a stderr writer and in hooks', () => {
  assert.doesNotThrow(() => surfaceServerWarnings({}, ['sem escritor aviso-a']));
  const lines = [];
  surfaceServerWarnings({ err: (text) => lines.push(text), hookEnteredAt: 1 }, ['dentro de hook aviso-b']);
  assert.deepEqual(lines, []);
  surfaceServerWarnings({ err: (text) => lines.push(text) }, ['Modo attach: info', 'aviso-c']);
  assert.deepEqual(lines, ['[opc] aviso: aviso-c\n']);
});
