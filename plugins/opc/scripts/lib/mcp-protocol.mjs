import { redactText } from './redact.mjs';

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const JsonRpcErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});
export const MAX_LINE_CHARS = 10 * 1024 * 1024;

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

function isValidId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: isValidId(id) ? id : null, error: { code, message: redactText(String(message)) } };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function publicTool(tool) {
  const out = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  if (tool.title) out.title = tool.title;
  if (tool.annotations) out.annotations = tool.annotations;
  return out;
}

function preview(value) {
  const text = redactText(String(value));
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

export function createMcpServer({ serverInfo, instructions = undefined, tools, callTool, log = () => {} }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const state = { initializeReceived: false, initialized: false, protocolVersion: null, clientInfo: null };

  async function handleRequest(message) {
    const { id, method } = message;
    const params = message.params ?? {};
    if (method === 'initialize') {
      state.initializeReceived = true;
      state.protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      state.clientInfo = params.clientInfo ?? null;
      const result = { protocolVersion: state.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo };
      if (instructions) result.instructions = instructions;
      return resultResponse(id, result);
    }
    if (method === 'ping') return resultResponse(id, {});
    if (!state.initializeReceived) return errorResponse(id, JsonRpcErrorCode.INVALID_REQUEST, 'Servidor não inicializado: envie initialize primeiro');
    if (method === 'tools/list') return resultResponse(id, { tools: tools.map(publicTool) });
    if (method === 'tools/call') {
      if (typeof params.name !== 'string') return errorResponse(id, JsonRpcErrorCode.INVALID_PARAMS, 'tools/call exige params.name');
      const tool = byName.get(params.name);
      if (!tool) return errorResponse(id, JsonRpcErrorCode.INVALID_PARAMS, `Ferramenta desconhecida: ${preview(params.name)}`);
      return resultResponse(id, await callTool(tool, params.arguments ?? {}));
    }
    return errorResponse(id, JsonRpcErrorCode.METHOD_NOT_FOUND, `Método desconhecido: ${preview(method)}`);
  }

  async function handle(message) {
    if (Array.isArray(message)) return errorResponse(null, JsonRpcErrorCode.INVALID_REQUEST, 'Lotes JSON-RPC não são aceitos');
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return errorResponse(message?.id, JsonRpcErrorCode.INVALID_REQUEST, 'Mensagem JSON-RPC 2.0 inválida');
    }
    if (typeof message.method !== 'string') return null;
    if (!('id' in message)) {
      if (message.method === 'notifications/initialized') state.initialized = true;
      return null;
    }
    if (!isValidId(message.id)) return errorResponse(null, JsonRpcErrorCode.INVALID_REQUEST, 'ID de requisição inválido');
    try {
      return await handleRequest(message);
    } catch (error) {
      log(`[opc] mcp: erro interno em ${preview(message.method)}: ${preview(redactText(String(error?.message ?? error)))}`);
      return errorResponse(message.id, JsonRpcErrorCode.INTERNAL_ERROR, 'Erro interno');
    }
  }

  return { handle, state };
}

export function createLineSplitter({ maxLineChars = MAX_LINE_CHARS } = {}) {
  let buffer = '';
  let discarding = false;
  return {
    push(chunk) {
      const lines = [];
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf('\n', start);
        if (!discarding) {
          buffer += chunk.slice(start, end < 0 ? undefined : end);
          if (end >= 0) {
            const line = buffer.replace(/\r$/, '');
            lines.push(line.length > maxLineChars ? null : line);
            buffer = '';
          } else if (buffer.length > maxLineChars + (buffer.endsWith('\r') ? 1 : 0)) {
            buffer = '';
            discarding = true;
            lines.push(null);
          }
        }
        if (end < 0) break;
        discarding = false;
        start = end + 1;
      }
      return lines;
    },
    flush() {
      const rest = buffer;
      buffer = '';
      const wasDiscarding = discarding;
      discarding = false;
      return !wasDiscarding && rest.trim() ? [rest] : [];
    },
  };
}

export function serveStdio({ server, input, write, log = () => {} }) {
  const splitter = createLineSplitter();
  const inFlight = new Set();
  const send = (response) => write(`${JSON.stringify(response)}\n`);

  return new Promise((resolve, reject) => {
    // Requests run concurrently so a long tools/call never blocks ping or other calls.
    function queue(action) {
      const task = Promise.resolve().then(action);
      inFlight.add(task);
      task.then(() => inFlight.delete(task), reject);
    }

    function processLine(line) {
      if (line === null) {
        queue(() => send(errorResponse(null, JsonRpcErrorCode.PARSE_ERROR, `Mensagem excede ${MAX_LINE_CHARS} caracteres`)));
        return;
      }
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        queue(() => send(errorResponse(null, JsonRpcErrorCode.PARSE_ERROR, 'Erro de análise: JSON inválido')));
        return;
      }
      queue(async () => {
        let response;
        try {
          response = await server.handle(message);
        } catch (error) {
          log(`[opc] mcp: ${preview(error?.message ?? error)}`);
          return;
        }
        if (response) send(response);
      });
    }

    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) processLine(line);
    });
    input.on('end', () => {
      for (const line of splitter.flush()) processLine(line);
      Promise.all(inFlight).then(resolve, reject);
    });
  });
}
