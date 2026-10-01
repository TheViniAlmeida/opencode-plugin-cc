#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`[opc] mcp: Node >= 20 necessário (encontrado ${process.versions.node})\n`);
  process.exit(1);
}

const { createMcpServer, serveStdio } = await import('./lib/mcp-protocol.mjs');
const { createToolCaller, SERVER_INSTRUCTIONS, TOOLS } = await import('./lib/mcp-tools.mjs');
const { main: dispatch } = await import('./opc-companion.mjs');

function pluginVersion() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const log = (line) => process.stderr.write(`${line}\n`);
const server = createMcpServer({
  serverInfo: { name: 'opc', title: 'opc — OpenCode para Claude Code', version: pluginVersion() },
  instructions: SERVER_INSTRUCTIONS,
  tools: TOOLS,
  callTool: createToolCaller({ dispatch, env: process.env, log }),
  log,
});

await serveStdio({ server, input: process.stdin, write: protocolWrite, log });
process.exit(0);
