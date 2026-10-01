import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { TOOL_NAMES } from '../../plugins/opc/scripts/lib/mcp-tools.mjs';
import { cliJson, makeTempDir, makeWorkspace, MCP_SERVER, PLUGIN_ROOT, registerStopper, startMcpClient, testEnv, trackTempDir } from '../helpers.mjs';

function setup(t, scenario = 'ok') {
  const env = testEnv(t, { scenario });
  const ws = makeWorkspace(t);
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  return { env, ws, mcpEnv };
}

function client(t, { mcpEnv, ws }, options = {}) {
  const c = startMcpClient({ env: mcpEnv, cwd: ws, ...options });
  registerStopper(t, () => c.close());
  return c;
}

test('plugin.json declara o servidor MCP stdio por CLAUDE_PLUGIN_ROOT', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers, { opc: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs'] } });
  assert.equal(manifest.mcpServers.opc.args[0].replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT), MCP_SERVER);
});

test('manifesto ausente ou inválido impede a inicialização do servidor', (t) => {
  const root = trackTempDir(t, makeTempDir('opc-mcp-manifest-'));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(MCP_SERVER, path.join(scripts, 'mcp-server.mjs'));
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'scripts', 'lib'), path.join(scripts, 'lib'), 'dir');
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'scripts', 'opc-companion.mjs'), path.join(scripts, 'opc-companion.mjs'));
  const manifestDir = path.join(root, '.claude-plugin');
  fs.mkdirSync(manifestDir);
  const manifest = path.join(manifestDir, 'plugin.json');
  fs.copyFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), manifest);
  const valid = spawnSync(process.execPath, [path.join(scripts, 'mcp-server.mjs')], { input: '', encoding: 'utf8' });
  assert.equal(valid.status, 0, `manifesto válido deve inicializar: ${valid.stderr}`);
  fs.unlinkSync(manifest);

  for (const [scenario, content] of [
    ['ausente', null],
    ['JSON inválido', '{'],
    ['versão ausente', '{}'],
  ]) {
    if (content !== null) fs.writeFileSync(manifest, content);
    const result = spawnSync(process.execPath, [path.join(scripts, 'mcp-server.mjs')], { input: '', encoding: 'utf8' });
    assert.equal(result.status, 1, `manifesto ${scenario} deve impedir a inicialização`);
  }
});

test('handshake: recusa antes de initialize, negociação, recursos, instruções e ping', async (t) => {
  const c = client(t, setup(t));
  const early = await c.request('tools/list');
  assert.equal(early.error.code, -32600);
  const init = await c.initialize('2025-06-18');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'opc');
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(init.result.serverInfo.version, manifest.version);
  assert.match(init.result.instructions, /confirmedByUser/);
  assert.deepEqual((await c.request('ping')).result, {});
});

test('initialize negocia versões anteriores e desconhecidas', async (t) => {
  const ctx = setup(t);
  for (const [asked, expected] of [['2024-11-05', '2024-11-05'], ['2025-03-26', '2025-03-26'], ['2099-01-01', '2025-06-18']]) {
    const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws });
    const init = await c.initialize(asked);
    assert.equal(init.result.protocolVersion, expected, asked);
    assert.equal(await c.close(), 0);
  }
});

test('tools/list devolve 25 ferramentas opc com JSON Schemas de objeto', async (t) => {
  const c = client(t, setup(t));
  await c.initialize();
  const res = await c.request('tools/list');
  assert.deepEqual(res.result.tools.map((tool) => tool.name), [...TOOL_NAMES]);
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  assert.equal(res.result.nextCursor, undefined);
});

test('erros de protocolo: parse com id null, método e ferramenta desconhecidos, notificações silenciosas', async (t) => {
  const c = client(t, setup(t));
  await c.initialize();
  c.sendRaw('{this is not json\n');
  const parse = await c.waitFor((message) => message.id === null && message.error?.code === -32700);
  assert.ok(parse);
  assert.equal((await c.request('resources/list')).error.code, -32601);
  const unknown = await c.request('tools/call', { name: 'opc_config_set', arguments: { key: 'policy.approver', value: 'claude' } });
  assert.equal(unknown.error.code, -32602);
  c.notify('notifications/cancelled', { requestId: 999, reason: 'test' });
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal(c.messages.filter((message) => !('id' in message)).length, 0);
});

test('ferramentas somente leitura devolvem o mesmo resultado da CLI', async (t) => {
  const ctx = setup(t);
  const c = client(t, ctx);
  await c.initialize();
  const pairs = [
    ['opc_models', {}, ['models']],
    ['opc_models', { allowed: true }, ['models', '--allowed']],
    ['opc_providers', {}, ['providers']],
    ['opc_agents', { mode: 'all' }, ['agents', '--mode', 'all']],
    ['opc_catalog', { kind: 'commands' }, ['catalog', 'commands']],
    ['opc_config_get', {}, ['config', 'get']],
    ['opc_config_get', { key: 'policy.approver' }, ['config', 'get', 'policy.approver']],
  ];
  for (const [name, args, cliArgs] of pairs) {
    const mcp = await c.callTool(name, args);
    const cli = await cliJson(cliArgs, { env: ctx.env, cwd: ctx.ws });
    assert.equal(mcp.envelope.exitCode, cli.code, `${name} exit code`);
    assert.equal(mcp.isError, cli.code !== 0, `${name} isError`);
    assert.deepEqual(mcp.envelope.data, cli.data, `${name} output`);
  }
});

test('stdout contém somente frames JSON-RPC mesmo com biblioteca escrevendo nele', async (t) => {
  const ctx = setup(t);
  const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f5-noise-'));
  t.after(() => fs.rmSync(preloadDir, { recursive: true, force: true }));
  const preload = path.join(preloadDir, 'noise.mjs');
  fs.writeFileSync(preload, "setTimeout(() => { console.log('NOISE-FROM-LIB'); process.stdout.write('RAW-NOISE\\n'); }, 1000);\n");
  const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws, nodeArgs: ['--import', pathToFileURL(preload).href] });
  await c.initialize();
  await c.callTool('opc_models', {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal(await c.close(), 0);
  for (const line of c.rawLines) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
  assert.match(c.stderr, /NOISE-FROM-LIB/);
  assert.match(c.stderr, /RAW-NOISE/);
});

test('servidor sai com código 0 ao fechar stdin', async (t) => {
  const ctx = setup(t);
  const c = startMcpClient({ env: ctx.mcpEnv, cwd: ctx.ws });
  await c.initialize();
  assert.equal(await c.close(), 0);
});
