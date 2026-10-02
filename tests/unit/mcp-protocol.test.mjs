import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

import {
  createLineSplitter,
  createMcpServer,
  errorResponse,
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  MAX_LINE_CHARS,
  negotiateProtocolVersion,
  serveStdio,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../plugins/opc/scripts/lib/mcp-protocol.mjs';

const TOOL = {
  name: 'echo', title: 'Eco', description: 'Repete argumentos',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true }, toArgv: () => [],
};

function makeServer(callTool = async (tool, args) => ({
  content: [{ type: 'text', text: JSON.stringify({ tool: tool.name, args }) }], isError: false,
})) {
  return createMcpServer({ serverInfo: { name: 'opc', version: '9.9.9' }, instructions: 'be careful', tools: [TOOL], callTool });
}

async function initialized(server, protocolVersion = LATEST_PROTOCOL_VERSION) {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}

test('protocol constants and negotiation', () => {
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-06-18');
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('2099-01-01'), '2025-06-18');
  assert.equal(negotiateProtocolVersion(undefined), '2025-06-18');
  assert.equal(MAX_LINE_CHARS, 10 * 1024 * 1024);
});

test('initialize returns capabilities, serverInfo, instructions and the negotiated version', async () => {
  const server = makeServer();
  const response = await initialized(server, '2025-03-26');
  assert.deepEqual(response, {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'opc', version: '9.9.9' }, instructions: 'be careful' },
  });
  assert.equal(server.state.initialized, true);
});

test('requests other than initialize/ping are refused before initialize', async () => {
  const server = makeServer();
  assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(response.error.code, JsonRpcErrorCode.INVALID_REQUEST);
  assert.equal(response.error.message, 'Servidor não inicializado: envie initialize primeiro');
});

test('tools/list exposes name, title, description, inputSchema and annotations only', async () => {
  const server = makeServer();
  await initialized(server);
  const response = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(response.result.tools, [{ name: 'echo', title: 'Eco', description: 'Repete argumentos', inputSchema: TOOL.inputSchema, annotations: { readOnlyHint: true } }]);
});

test('tools/call delegates to callTool; unknown tool is -32602', async () => {
  const server = makeServer();
  await initialized(server);
  const ok = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { tool: 'echo', args: { a: 1 } });
  const unknown = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'opc_config_set_very_long_user_value', arguments: {} } });
  assert.equal(unknown.error.code, JsonRpcErrorCode.INVALID_PARAMS);
  assert.equal(unknown.error.message, 'Ferramenta desconhecida: opc_config_s…');
  const noName = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, JsonRpcErrorCode.INVALID_PARAMS);
});

test('method not found, invalid messages, batches, notifications and client responses', async () => {
  const server = makeServer();
  await initialized(server);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code, JsonRpcErrorCode.METHOD_NOT_FOUND);
  assert.equal((await server.handle({ id: 8, method: 'ping' })).error.code, JsonRpcErrorCode.INVALID_REQUEST);
  assert.deepEqual((await server.handle([{ jsonrpc: '2.0', id: 9, method: 'ping' }])).id, null);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, JsonRpcErrorCode.INVALID_REQUEST);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 10, result: {} }), null);
});

test('an exception inside callTool becomes -32603 with a redacted message', async () => {
  const server = makeServer(async () => { throw new Error('boom'); });
  await initialized(server);
  const response = await server.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo' } });
  assert.deepEqual(response.error, { code: JsonRpcErrorCode.INTERNAL_ERROR, message: 'Erro interno' });
});

test('createLineSplitter handles partial chunks, CRLF and oversize lines', () => {
  const splitter = createLineSplitter({ maxLineChars: 10 });
  assert.deepEqual(splitter.push('{"a"'), []);
  assert.deepEqual(splitter.push(':1}\r\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(splitter.push('x'.repeat(11)), [null]);
  assert.deepEqual(splitter.push('tail'), []);
  assert.deepEqual(splitter.flush(), []);
});

test('createLineSplitter drops the entire oversize line across chunks, then resumes', () => {
  const splitter = createLineSplitter({ maxLineChars: 10 });
  assert.deepEqual(splitter.push('123456'), []);
  assert.deepEqual(splitter.push('78901'), [null]);
  assert.deepEqual(splitter.push('still part of the same line'), []);
  assert.deepEqual(splitter.push('\n{"ok":1}\n'), ['{"ok":1}']);
  assert.deepEqual(splitter.flush(), []);
});

test('serveStdio dispatches only the valid line following a multi-chunk oversize line', async () => {
  const input = new PassThrough();
  const handled = [];
  const written = [];
  const server = { handle: async (message) => {
    handled.push(message);
    return { jsonrpc: '2.0', id: message.id, result: {} };
  } };
  const done = serveStdio({ server, input, write: (line) => written.push(JSON.parse(line)) });
  input.write('x'.repeat(MAX_LINE_CHARS - 2));
  input.write('xxxx');
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  input.end('\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await done;
  assert.deepEqual(handled, [{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.deepEqual(written.map((response) => [response.id, response.error?.code]), [
    [null, JsonRpcErrorCode.PARSE_ERROR], [2, undefined],
  ]);
});

test('serveStdio answers each line, reports parse errors with id null and ends with the input', async () => {
  const server = makeServer();
  const input = new PassThrough();
  const written = [];
  const done = serveStdio({ server, input, write: (line) => written.push(line) });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  input.write('{not json\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  input.end();
  await done;
  const messages = written.map((line) => {
    assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'), 'uma mensagem JSON por linha');
    return JSON.parse(line);
  });
  assert.equal(messages.length, 3);
  assert.ok(messages.some((message) => message.id === 1 && message.result.protocolVersion === '2025-06-18'));
  assert.ok(messages.some((message) => message.id === null && message.error.code === JsonRpcErrorCode.PARSE_ERROR));
  assert.ok(messages.some((message) => message.id === 2 && typeof message.result === 'object'));
});

test('errorResponse masks registered secrets', () => {
  registerSecret('fake-secret-123');
  const response = errorResponse(1, JsonRpcErrorCode.INVALID_PARAMS, 'Valor inválido: fake-secret-123');
  assert.equal(response.error.code, JsonRpcErrorCode.INVALID_PARAMS);
  assert.equal(response.error.message, 'Valor inválido: ***');
});

test('unknown tool and method names redact registered secrets before previewing', async () => {
  const secret = 'test-only-sensitive-tool-name';
  registerSecret(secret);
  const server = makeServer();
  await initialized(server);
  for (const request of [
    { method: 'tools/call', params: { name: secret }, code: JsonRpcErrorCode.INVALID_PARAMS },
    { method: secret, code: JsonRpcErrorCode.METHOD_NOT_FOUND },
  ]) {
    const response = await server.handle({ jsonrpc: '2.0', id: 42, method: request.method, params: request.params });
    assert.equal(response.error.code, request.code);
    assert.ok(!JSON.stringify(response).includes(secret.slice(0, 8)));
    assert.match(response.error.message, /\*\*\*/);
  }
});

test('serveStdio answers a ping while a slow request is still pending', async () => {
  const input = new PassThrough();
  const written = [];
  let release;
  const server = { handle: async (message) => {
    if (message.method === 'slow') await new Promise((resolve) => { release = resolve; });
    return { jsonrpc: '2.0', id: message.id, result: {} };
  } };
  const done = serveStdio({ server, input, write: (line) => written.push(JSON.parse(line).id) });
  input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, [2]);
  release();
  input.end();
  await done;
  assert.deepEqual(written, [2, 1]);
});

test('serveStdio rejects when writing a response throws', async () => {
  const input = new PassThrough();
  const failure = new Error('test writer failed');
  const done = serveStdio({ server: makeServer(), input, write: () => { throw failure; } });
  input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await assert.rejects(done, (error) => error === failure);
});

test('serveStdio rejects when writing a parse error throws', async () => {
  const input = new PassThrough();
  const failure = new Error('test parse writer failed');
  const done = serveStdio({ server: makeServer(), input, write: () => { throw failure; } });
  input.end('{invalid json\n');
  await assert.rejects(done, (error) => error === failure);
});

test('oversize complete lines do not reach JSON parsing', () => {
  const splitter = createLineSplitter({ maxLineChars: 4 });
  assert.deepEqual(splitter.push('12345\n{}\n'), [null, '{}']);
});

test('internal errors do not expose the full failure detail in logs', async () => {
  const logs = [];
  const server = createMcpServer({
    serverInfo: { name: 'opc', version: '9.9.9' }, tools: [TOOL],
    callTool: async () => { throw new Error('valor-fornecido-confidencial'); },
    log: (line) => logs.push(line),
  });
  await initialized(server);
  const response = await server.handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'echo' } });
  assert.equal(response.error.code, JsonRpcErrorCode.INTERNAL_ERROR);
  assert.equal(response.error.message, 'Erro interno');
  assert.deepEqual(logs, ['[opc] mcp: erro interno em tools/call: valor-fornec…']);
});
