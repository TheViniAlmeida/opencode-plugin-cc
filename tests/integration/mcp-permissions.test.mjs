import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DESTRUCTIVE_ID, SAFE_ID, SENSITIVE_ID } from '../fixtures/scenarios/mcp-pending-permission.mjs';
import { cliJson, makeWorkspace, readFakeState, registerStopper, startExternalFake, startMcpClient, testEnv, writeTestConfig } from '../helpers.mjs';

async function setup(t, approver) {
  const external = await startExternalFake(t, { scenario: 'mcp-pending-permission' });
  const env = testEnv(t, { scenario: 'mcp-pending-permission', extra: {
    OPC_SERVER_URL: external.url,
    OPC_SERVER_PASSWORD: external.password,
    FAKE_OPENCODE_STATE: external.stateFile,
  } });
  const ws = makeWorkspace(t);
  writeTestConfig(env, { policy: { approver } });
  const mcpEnv = { ...env, CLAUDE_PROJECT_DIR: ws };
  delete mcpEnv.OPC_COMPANION_SESSION_ID;
  const c = startMcpClient({ env: mcpEnv, cwd: ws });
  registerStopper(t, () => c.close());
  return { env, ws, c };
}

function replies(env) {
  return readFakeState(env).requests.filter((request) => request.method === 'POST' && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(request.path));
}

async function assertPending(c, id) {
  const listed = await c.callTool('opc_permissions_list', {});
  assert.equal(listed.envelope.exitCode, 0);
  assert.ok(listed.envelope.data.requests.some((request) => request.id === id), 'solicitação semeada deve estar pendente');
}

test('opc_permissions_list devolve as mesmas solicitações pendentes da CLI', async (t) => {
  const { env, ws, c } = await setup(t, 'user');
  await c.initialize();
  const mcp = await c.callTool('opc_permissions_list', {});
  const cli = await cliJson(['permissions', 'list'], { env, cwd: ws });
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.deepEqual(mcp.envelope.data, cli.data);
  assert.ok(mcp.envelope.data.requests.some((request) => request.id === DESTRUCTIVE_ID));
});

for (const [label, id] of [['comando destrutivo', DESTRUCTIVE_ID], ['caminho sensível', SENSITIVE_ID]]) {
  test(`aprovador claude recusa ${label} sem confirmedByUser, sem enviar resposta`, async (t) => {
    const { env, ws, c } = await setup(t, 'claude');
    await c.initialize();
    await assertPending(c, id);
    const cli = await cliJson(['permissions', 'reply', id, 'once'], { env, cwd: ws });
    const mcp = await c.callTool('opc_permissions_reply', { requestId: id, reply: 'once' });
    assert.equal(mcp.envelope.error.code, 'NEEDS_USER');
    assert.equal(cli.data.error.code, 'NEEDS_USER');
    assert.equal(mcp.envelope.exitCode, cli.code);
    assert.equal(mcp.isError, true);
    assert.equal(replies(env).length, 0);
  });

  test(`aprovador claude envia ${label} como once após confirmedByUser`, async (t) => {
    const { env, c } = await setup(t, 'claude');
    await c.initialize();
    await assertPending(c, id);
    const mcp = await c.callTool('opc_permissions_reply', { requestId: id, reply: 'once', confirmedByUser: true });
    assert.equal(mcp.envelope.exitCode, 0);
    const sent = replies(env);
    assert.equal(sent.length, 1);
    assert.match(sent[0].path, new RegExp(`/permission/${id}/reply$`));
    assert.equal(sent[0].body.decision, 'once');
  });
}

test('aprovador claude responde solicitação segura sem confirmação do usuário', async (t) => {
  const { env, c } = await setup(t, 'claude');
  await c.initialize();
  await assertPending(c, SAFE_ID);
  const mcp = await c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'reject', message: '--not now' });
  assert.equal(mcp.envelope.exitCode, 0);
  const sent = replies(env);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.decision, 'reject');
  assert.equal(sent[0].body.message, '[REDACTED]');
});

test('aprovador user aplica a mesma regra da CLI sem confirmedByUser', async (t) => {
  const cliSide = await setup(t, 'user');
  await cliSide.c.initialize();
  await assertPending(cliSide.c, SAFE_ID);
  const cli = await cliJson(['permissions', 'reply', SAFE_ID, 'once'], { env: cliSide.env, cwd: cliSide.ws });
  const mcpSide = await setup(t, 'user');
  await mcpSide.c.initialize();
  await assertPending(mcpSide.c, SAFE_ID);
  const mcp = await mcpSide.c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'once' });
  assert.equal(mcp.envelope.error.code, 'NEEDS_USER');
  assert.equal(cli.data.error.code, 'NEEDS_USER');
  assert.equal(mcp.envelope.exitCode, cli.code);
  assert.equal(replies(mcpSide.env).length, replies(cliSide.env).length);
  assert.equal(replies(mcpSide.env).length, 0);
});

test('a resposta always nunca chega ao servidor OpenCode', async (t) => {
  const { env, c } = await setup(t, 'claude');
  await c.initialize();
  await assertPending(c, SAFE_ID);
  const mcp = await c.callTool('opc_permissions_reply', { requestId: SAFE_ID, reply: 'always', confirmedByUser: true });
  assert.equal(mcp.envelope.error.code, 'INVALID_ARGUMENTS');
  assert.equal(mcp.isError, true);
  assert.equal(mcp.envelope.exitCode, 2);
  assert.equal(replies(env).length, 0);
});

test('nenhuma chamada MCP grava configuração', async (t) => {
  const { env, c } = await setup(t, 'user');
  const configFile = path.join(env.OPC_DATA_DIR, 'config.json');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  const before = hash();
  await c.initialize();
  for (const name of ['opc_config_set', 'opc_config_unset', 'opc_config_add', 'opc_config_remove', 'opc_setup']) {
    const response = await c.request('tools/call', { name, arguments: { key: 'policy.approver', value: 'claude' } });
    assert.equal(response.error.code, -32602, name);
  }
  const injected = await c.callTool('opc_config_get', { key: '--tty-confirm' });
  assert.equal(injected.envelope.error.code, 'INVALID_ARGUMENTS');
  await c.callTool('opc_config_get', { key: 'policy' });
  assert.equal(hash(), before);
});
