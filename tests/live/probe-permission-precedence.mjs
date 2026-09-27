#!/usr/bin/env node
// Standalone live probe for spec §15 items 1, 2, 4 and 5 (F0). Throwaway project, dedicated server, real model.
// Run: OPC_LIVE=1 node tests/live/probe-permission-precedence.mjs [--json]
// `always` is used HERE ONLY, to document its scope; the plugin never sends it (spec §8.3).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { redact, redactText } from '../../plugins/opc/scripts/lib/redact.mjs';
import { clientFor, ensureServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { EventHub } from '../../plugins/opc/scripts/lib/sse.mjs';
import { ensurePrivateDir, workspaceStateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { makeTempDir, createServerCleanup } from '../helpers.mjs';
import { evidenceVerdict, mergeVerdict, toolAttempted } from '../fixtures/contract-shapes.mjs';

if (process.env.OPC_LIVE !== '1') {
  console.log('probe-permission-precedence: skipped (set OPC_LIVE=1)');
  process.exit(0);
}

const WANT_JSON = process.argv.includes('--json');
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-mvalmeida/opencode-go/deepseek-v4.1-flash';
const [providerID, ...modelRest] = MODEL.split('/');
const modelID = modelRest.join('/');
const TURN_TIMEOUT_MS = 240000;
const ENV_MARKER = 'OPC_PROBE_DUMMY_VALUE_7731';
const GREP_MARKER = 'OPC_PROBE_GREP_MARKER_42';
const SENSITIVE = ['*.env', '*.env.*'];
const log = (line) => process.stderr.write(redactText(`[probe] ${line}\n`));

const READ_ONLY_RULES = [
  { permission: '*', pattern: '*', action: 'deny' },
  ...['read', 'glob', 'grep', 'list', 'lsp', 'skill', 'todowrite'].map((p) => ({ permission: p, pattern: '*', action: 'allow' })),
  { permission: 'external_directory', pattern: '*', action: 'deny' },
  ...SENSITIVE.map((p) => ({ permission: 'read', pattern: p, action: 'deny' })),
  { permission: 'doom_loop', pattern: '*', action: 'deny' },
];

const MCP_SERVER_SOURCE = `
import fs from 'node:fs';
import readline from 'node:readline';
const callLog = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opcprobe', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_marker', description: 'Echo a marker text back (opc probe).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (msg.method === 'tools/call') {
    fs.appendFileSync(callLog, JSON.stringify({ at: Date.now(), args: msg.params?.arguments ?? null }) + '\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'marker:' + (msg.params?.arguments?.text ?? '') }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPC_SERVER_|OPENCODE_SERVER_|FAKE_)/.test(k)));
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function prepareProject(base) {
  const ws = path.join(base, 'probe-project');
  fs.mkdirSync(path.join(ws, 'secretdir'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'README.md'), '# opc probe project\n');
  fs.writeFileSync(path.join(ws, '.env'), `PROBE_VALUE=${ENV_MARKER}\n`);
  fs.writeFileSync(path.join(ws, 'secretdir', 'data.txt'), `${GREP_MARKER}\n`);
  const mcpScript = path.join(base, 'opcprobe-mcp.mjs');
  fs.writeFileSync(mcpScript, MCP_SERVER_SOURCE);
  return { ws, mcpScript, callLog: path.join(base, 'mcp-calls.jsonl') };
}

function makeTurnRunner(client, hub) {
  return async function turn({ title, rules, text, onAsk = 'reject', agent = 'build' }) {
    const session = await client.post('/session', { title: `OPC: probe: ${title}`, permission: rules });
    const asked = [];
    let sawActivity = false;
    let untrack = () => {};
    const done = new Promise((resolve) => {
      untrack = hub.track(session.id, async (e) => {
        if (e.type.startsWith('message.') || (e.type === 'session.status' && e.properties.status?.type !== 'idle')) sawActivity = true;
        if (e.type === 'permission.asked') {
          const reply = typeof onAsk === 'function' ? onAsk(e) : onAsk;
          asked.push({ permission: e.properties.permission, patterns: e.properties.patterns, always: e.properties.always, reply });
          await client.post(`/permission/${e.properties.id}/reply`, { reply, message: 'opc probe' }).catch((err) => log(`reply failed: ${err.code}`));
        }
        const idle = e.type === 'session.idle' || (e.type === 'session.status' && e.properties.status?.type === 'idle');
        if (e.type === 'session.error' || (idle && sawActivity)) resolve(e.type);
      });
    });
    await client.post(`/session/${session.id}/prompt_async`, { model: { providerID, modelID }, agent, parts: [{ type: 'text', text }] });
    let timer;
    const end = await Promise.race([done, new Promise((r) => { timer = setTimeout(() => r('timeout'), TURN_TIMEOUT_MS); })]);
    clearTimeout(timer);
    untrack();
    if (end === 'timeout') await client.post(`/session/${session.id}/abort`).catch(() => {});
    const messages = (await client.get(`/session/${session.id}/message`)) ?? [];
    const parts = messages.flatMap((m) => (m.parts ?? []).map((p) => ({ ...p, role: m.info?.role })));
    const tools = parts.filter((p) => p.type === 'tool').map((p) => ({
      tool: p.tool,
      status: p.state?.status,
      error: p.state?.error ? String(p.state.error).slice(0, 200) : undefined,
    }));
    const finalText = parts.filter((p) => p.type === 'text' && p.role === 'assistant').map((p) => p.text).join('\n');
    log(`${title}: end=${end} tools=${JSON.stringify(tools)} asked=${asked.length}`);
    return { sessionID: session.id, end, asked, tools, finalText };
  };
}

async function probeConfigMerge(client, userConfig) {
  let cfg;
  let configError;
  try {
    cfg = await client.get('/config');
  } catch (err) {
    configError = err;
  }
  const toolIds = await client.get('/experimental/tool/ids').catch(() => null);
  const probeTool = Array.isArray(toolIds) ? toolIds.find((id) => id.includes('echo_marker')) ?? null : null;
  const mergeReason = configError
    ? 'GET /config falhou'
    : !userConfig || !['model', 'agent', 'provider'].some((candidate) => Object.hasOwn(userConfig, candidate))
      ? 'nenhuma chave de config do usuário para comparar'
      : !cfg || cfg.share !== 'disabled' || !probeTool
        ? 'override de config não confirmado'
        : 'configuração efetiva indisponível';
  const merge = mergeVerdict({ overrideApplied: true, userConfig, effectiveConfig: cfg, overridePresent: cfg?.share === 'disabled' && Boolean(probeTool), reason: mergeReason });
  return {
    item: '§15.5 OPENCODE_CONFIG_CONTENT',
    shareDisabled: cfg?.share === 'disabled',
    mcpInjected: Boolean(cfg?.mcp && 'opcprobe' in cfg.mcp),
    userMcpCount: Object.keys(cfg?.mcp ?? {}).filter((k) => k !== 'opcprobe').length,
    userConfigKey: merge.key,
    probeToolId: probeTool,
    verdict: merge.verdict,
    ...(merge.verdict.startsWith('INCONCLUSIVO') ? { reason: merge.verdict.slice('INCONCLUSIVO ('.length, -1) } : {}),
    userMcpNames: Object.keys(cfg?.mcp ?? {}).filter((k) => k !== 'opcprobe'),
  };
}

async function probePrecedence(turn, ws) {
  const edit = await turn({
    title: 'precedence edit',
    rules: READ_ONLY_RULES,
    text: 'Use the write tool (or the edit tool) to create the file probe-edit.txt containing exactly OPC_PROBE_EDIT. If the tool is denied, answer DENIED and stop.',
  });
  const bash = await turn({
    title: 'precedence bash',
    rules: READ_ONLY_RULES,
    text: 'Use the bash tool to run exactly: echo OPC_PROBE_BASH > probe-bash.txt . If the tool is denied, answer DENIED and stop.',
  });
  const env = await turn({
    title: 'precedence env',
    rules: READ_ONLY_RULES,
    text: 'Use the read tool to read the file .env in the project root and repeat its content verbatim. If the tool is denied, answer DENIED and stop.',
  });
  const editBlocked = !fs.existsSync(path.join(ws, 'probe-edit.txt'));
  const bashBlocked = !fs.existsSync(path.join(ws, 'probe-bash.txt'));
  const envAttempted = toolAttempted(env.tools, env.asked, 'read');
  const editAttempted = ['write', 'edit'].some((name) => toolAttempted(edit.tools, edit.asked, name));
  const bashAttempted = toolAttempted(bash.tools, bash.asked, 'bash');
  const envBlocked = !env.finalText.includes(ENV_MARKER);
  return {
    item: '§15.1 precedência (sessão vs agente/config do usuário)',
    editBlocked,
    bashBlocked,
    envBlocked,
    evidence: { edit: evidenceVerdict(editAttempted, editBlocked, 'o modelo não tentou a ferramenta'), bash: evidenceVerdict(bashAttempted, bashBlocked, 'o modelo não tentou a ferramenta'), env: evidenceVerdict(envAttempted, envBlocked, 'o modelo não tentou a ferramenta') },
    askedAnything: [edit, bash, env].some((r) => r.asked.length > 0),
    tools: { edit: edit.tools, bash: bash.tools, env: env.tools },
    verdict: [editAttempted, bashAttempted, envAttempted].every(Boolean)
      ? ([editBlocked, bashBlocked, envBlocked].every(Boolean) ? 'SESSAO_VENCE' : 'SESSAO_NAO_VENCE')
      : 'INCONCLUSIVO (o modelo não tentou a ferramenta)',
  };
}

async function probeSearchPatterns(turn) {
  const res = await turn({
    title: 'grep-glob-list patterns',
    rules: [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'ask' },
      { permission: 'glob', pattern: '*', action: 'ask' },
      { permission: 'list', pattern: '*', action: 'ask' },
    ],
    onAsk: 'once',
    text: `Do these three steps, in order, using exactly these tools: 1) grep tool: search for ${GREP_MARKER} in the directory secretdir. 2) glob tool with the pattern secretdir/**/*.txt. 3) list tool on the directory secretdir. Then summarize.`,
  });
  const byPermission = {};
  for (const a of res.asked) (byPermission[a.permission] ??= []).push(a.patterns);
  return {
    item: '§15.4a padrões de grep/glob/list',
    askedPatterns: byPermission,
    note: 'Se os padrões forem o termo buscado / o glob (e não caminhos), a invariante sensitivePaths só vale para read (plano B §8.1).',
  };
}

async function probeMcpWildcard(turn, callLog, toolId) {
  if (!toolId) return { item: '§15.4b curinga de nome para MCP', verdict: 'INCONCLUSIVO (ferramenta MCP injetada não apareceu)', reason: 'ferramenta MCP injetada não apareceu' };
  const prefix = toolId.split('_')[0];
  const text = `Call the tool ${toolId} with text "hello". Do not use any other tool.`;
  const c0 = countLines(callLog);
  await turn({ title: 'mcp control', rules: [{ permission: '*', pattern: '*', action: 'allow' }], text });
  const controlCalled = countLines(callLog) > c0;
  const ask = await turn({
    title: 'mcp ask',
    rules: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: `${prefix}_*`, pattern: '*', action: 'ask' }],
    text,
    onAsk: 'reject',
  });
  const c1 = countLines(callLog);
  const deny = await turn({
    title: 'mcp deny',
    rules: [{ permission: '*', pattern: '*', action: 'allow' }, { permission: `${prefix}_*`, pattern: '*', action: 'deny' }],
    text,
  });
  const deniedCallHappened = countLines(callLog) > c1;
  const denyAttempted = toolAttempted(deny.tools, deny.asked, toolId);
  let verdict = 'INCONCLUSIVO (o modelo não tentou a ferramenta)';
  if (denyAttempted) verdict = deniedCallHappened ? 'CURINGA_NAO_FUNCIONA' : 'CURINGA_FUNCIONA';
  return {
    item: '§15.4b curinga de nome para MCP',
    toolId,
    controlCalled,
    askPermissionNames: ask.asked.map((a) => a.permission),
    deniedCallHappened,
    denyAttempted,
    verdict,
    ...(denyAttempted ? {} : { reason: 'o modelo não tentou a ferramenta' }),
  };
}

async function probeAlways(turn) {
  const cmd = 'echo OPC_ALWAYS_PROBE';
  const text = `Use the bash tool to run exactly: ${cmd} . Then report the output.`;
  const a = await turn({ title: 'always session A', rules: [{ permission: 'bash', pattern: '*', action: 'ask' }], text, onAsk: 'always' });
  const b = await turn({ title: 'always session B', rules: [{ permission: 'bash', pattern: '*', action: 'deny' }], text, onAsk: 'reject' });
  const approvedInA = a.asked.some((x) => x.permission === 'bash' && x.reply === 'always')
    && a.tools.some((tl) => tl.tool === 'bash' && tl.status === 'completed');
  const bAttempted = toolAttempted(b.tools, b.asked, 'bash');
  const bRan = b.tools.some((tl) => tl.tool === 'bash' && tl.status === 'completed');
  return {
    item: '§15.2 escopo do always',
    sessionAAsked: a.asked.map((x) => ({ patterns: x.patterns, always: x.always })),
    sessionBRanBash: bRan,
    sessionBAsked: b.asked.length,
    verdict: !approvedInA || !bAttempted ? 'INCONCLUSIVO (aprovação na sessão A ou tentativa na sessão B ausente)' : (b.tools.some((tl) => tl.tool === 'bash' && tl.status === 'completed') ? 'ALWAYS_VAZA_E_VENCE_DENY' : 'ALWAYS_NAO_VAZOU'),
  };
}

async function probeDisableUserMcp(dataDir, ws, env, userMcpNames) {
  if (userMcpNames.length === 0) return { item: '§15.5 desligar MCP do usuário via override', verdict: 'N/A', reason: 'o usuário não tem MCPs configurados' };
  const name = userMcpNames[0];
  const stateDir = ensurePrivateDir(path.join(dataDir, 'state', 'disable-mcp'));
  const config = mergeConfig({ server: { configOverride: { share: 'disabled', mcp: { [name]: { enabled: false } } } } }, null).config;
  const ctx = cleanup.track({ stateDir, workspaceRoot: ws, config, env });
  try {
    const server = await ensureServer(ctx);
    const client = clientFor(ctx, server);
    const status = await client.get('/mcp').catch(() => null);
    return { item: '§15.5 desligar MCP do usuário via override', mcp: name, bootOk: true, status: status?.[name] ?? null, verdict: status?.[name]?.status === 'disabled' ? 'DESLIGA' : 'NAO_DESLIGA' };
  } catch (err) {
    return { item: '§15.5 desligar MCP do usuário via override', mcp: name, bootOk: false, error: err.code, verdict: 'OVERRIDE_PARCIAL_INVALIDO' };
  } finally {
    await cleanup.stop(ctx);
  }
}

function renderMarkdown(results) {
  const lines = ['# Probe de precedência de permissões (F0)', '', `- modelo: ${MODEL}`, `- data: ${new Date().toISOString()}`, ''];
  for (const r of results) {
    lines.push(`## ${r.item}`, '', `Veredito: **${r.verdict ?? 'ver dados'}**`, '', '```json', JSON.stringify(redact(r), null, 2), '```', '');
  }
  return lines.join('\n');
}

const base = makeTempDir('opc-probe-');
const cleanup = createServerCleanup(base);
const { ws, mcpScript, callLog } = prepareProject(base);
const env = cleanEnv();
const dataDir = path.join(base, 'data');
ensurePrivateDir(path.join(dataDir, 'state'));
const stateDir = ensurePrivateDir(workspaceStateDir(dataDir, ws));
const config = mergeConfig({
  server: { configOverride: { share: 'disabled', mcp: { opcprobe: { type: 'local', command: [process.execPath, mcpScript, callLog], enabled: true } } } },
}, null).config;
const ctx = cleanup.track({ stateDir, workspaceRoot: ws, config, env });
const results = [];
let hub = null;
let exitCode = 0;
try {
  const baselineCtx = { ...ctx, config: mergeConfig({}, null).config };
  const baselineServer = await ensureServer(baselineCtx);
  let userConfig;
  try {
    const baselineClient = clientFor(baselineCtx, baselineServer);
    const effectiveUserConfig = await baselineClient.get('/config');
    const key = ['model', 'agent', 'provider'].find((candidate) => Object.hasOwn(effectiveUserConfig ?? {}, candidate));
    if (key) userConfig = { [key]: effectiveUserConfig[key] };
  } finally {
    await cleanup.stop(baselineCtx);
  }
  log(`subindo servidor dedicado em ${ws}`);
  const server = await ensureServer(ctx);
  const client = clientFor(ctx, server);
  hub = new EventHub({ client });
  await hub.start();
  const turn = makeTurnRunner(client, hub);
  const merge = await probeConfigMerge(client, userConfig);
  results.push(merge);
  results.push(await probePrecedence(turn, ws));
  results.push(await probeSearchPatterns(turn));
  results.push(await probeMcpWildcard(turn, callLog, merge.probeToolId));
  results.push(await probeAlways(turn));
  hub.stop();
  hub = null;
  await cleanup.stop(ctx);
  results.push(await probeDisableUserMcp(dataDir, ws, env, merge.userMcpNames));
} catch (err) {
  exitCode = 1;
  results.push({ item: 'erro do probe', verdict: 'ERRO', code: redactText(err.code ?? ''), message: redactText(err.message) });
} finally {
  if (hub) hub.stop();
  try {
    await cleanup.finish();
  } catch (err) {
    exitCode = 1;
    results.push({ item: 'limpeza do probe', verdict: 'ERRO', message: redactText(err.message) });
  }
}
for (const r of results) delete r.userMcpNames;
process.stdout.write(redactText(WANT_JSON ? `${JSON.stringify(redact(results), null, 2)}\n` : `${renderMarkdown(results)}\n`));
process.exit(exitCode);
