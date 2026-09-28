import { join } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, resolveModel, requireAgent, profileRules } from '../lib/context.mjs';
import { assertId } from '../lib/api.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderSession, renderSessions, renderSessionDiff, renderTodos, renderRevertPreview } from '../lib/render.mjs';
import { readSessionMessages } from '../lib/session-messages.mjs';
import { redactText, maskSecretPatterns } from '../lib/redact.mjs';

const SPEC = {
  flags: {
    title: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    write: { type: 'boolean' },
    limit: { type: 'number', default: 20 },
    part: { type: 'string' },
    message: { type: 'string' },
    'confirmed-by-user': { type: 'boolean' },
    timeout: { type: 'number' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
  allowPositionals: true,
};

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

async function actionNew(ctx, api, { flags }) {
  const policy = ctx.config.policy ?? {};
  const body = {
    title: `OPC: session: ${oneLine(flags.title || 'manual').slice(0, 72)}`,
    permission: profileRules(ctx, flags.write ? 'write' : 'read-only'),
  };
  {
    const discovery = await loadDiscovery(api);
    const agentName = flags.agent ?? ctx.config.defaultAgent ?? null;
    if (agentName) body.agent = requireAgent(discovery, agentName, policy).name;
    const model = resolveModel(ctx, discovery, 'task', flags.model ?? null);
    body.model = { id: model.modelID, providerID: model.providerID };
  }
  const session = await api.createSession(body);
  if (flags.json) ctx.json({ session });
  else ctx.out(renderSession(session, { note: `Continue com: /opc:task --resume ${session.id} <prompt> · veja na TUI: /opc:attach ${session.id}` }));
  return ExitCode.OK;
}

async function actionShow(ctx, api, { flags, sessionID }) {
  const [session, statusMap, messages] = await Promise.all([
    api.getSession(sessionID),
    api.sessionStatus(),
    readSessionMessages(api, sessionID, { limit: flags.limit }),
  ]);
  const status = statusMap?.[sessionID]?.type ?? 'idle';
  const unavailable = messages?.messagesUnavailable === true;
  const safeSession = maskContent(session);
  const safeMessages = maskContent(messages ?? []);
  if (flags.json) ctx.json({ session: safeSession, status, messages: safeMessages, ...(unavailable ? { messagesUnavailable: true, reason: 'OPENCODE_LIST_BUG' } : {}) });
  else {
    if (unavailable) ctx.out('As mensagens desta sessão não podem ser listadas por um defeito do OpenCode 1.18.32 com saída estruturada; o diff e os filhos continuam disponíveis.\n');
    ctx.out(renderSession(safeSession, { status, messages: safeMessages }));
  }
  return ExitCode.OK;
}

async function actionFork(ctx, api, { flags, sessionID, rest }) {
  const messageID = rest[1] ? assertId('msg', rest[1], 'mensagem') : undefined;
  const forked = await api.fork(sessionID, { messageID });
  if (flags.json) ctx.json({ session: forked, forkedFrom: { sessionID, messageID: messageID ?? null } });
  else ctx.out(renderSession(forked, { note: `Fork de ${sessionID}${messageID ? `, com o histórico anterior a ${messageID}` : ''}.` }));
  return ExitCode.OK;
}

async function actionChildren(ctx, api, { flags, sessionID }) {
  const children = (await api.children(sessionID)) ?? [];
  if (flags.json) ctx.json({ sessionID, children });
  else ctx.out(renderSessions(children, { title: `Filhas de ${sessionID}` }));
  return ExitCode.OK;
}

async function actionDiff(ctx, api, { flags, sessionID }) {
  const messageID = flags.message !== undefined ? assertId('msg', flags.message, 'mensagem') : undefined;
  const diffs = (await api.diff(sessionID, { messageID })) ?? [];
  const safeDiffs = maskContent(diffs);
  if (flags.json) ctx.json({ sessionID, messageID: messageID ?? null, diffs: safeDiffs });
  else ctx.out(renderSessionDiff(safeDiffs, { title: `Diff da sessão ${sessionID}${messageID ? ` (mensagem ${messageID})` : ''}` }));
  return ExitCode.OK;
}

async function actionTodo(ctx, api, { flags, sessionID }) {
  const todos = (await api.todo(sessionID)) ?? [];
  if (flags.json) ctx.json({ sessionID, todos });
  else ctx.out(renderTodos(todos, { sessionID }));
  return ExitCode.OK;
}

const ACTIONS = {
  new: actionNew,
  show: actionShow,
  fork: actionFork,
  children: actionChildren,
  diff: actionDiff,
  todo: actionTodo,
};

// Validates every id before connecting, so malformed input never reaches the server.
function validateIds(action, rest, flags) {
  if (action === 'new') return null;
  if (!rest[0]) throw new UsageError('MISSING_ID', `session ${action} exige <sessionID>`);
  const sessionID = assertId('ses', rest[0], 'sessão');
  if (rest[1] && ['fork', 'revert'].includes(action)) assertId('msg', rest[1], 'mensagem');
  if (flags.message !== undefined) assertId('msg', flags.message, 'mensagem');
  if (flags.part) assertId('prt', flags.part, 'parte');
  return sessionID;
}

function maskContent(value) {
  if (typeof value === 'string') return redactText(maskSecretPatterns(value));
  if (Array.isArray(value)) return value.map(maskContent);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskContent(item)]));
  return value;
}

export async function run(ctx, argv) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  const [action, ...rest] = positionals;
  const handler = ACTIONS[action];
  if (!handler) {
    const shown = String(action ?? '').slice(0, 12);
    throw new UsageError('UNKNOWN_ACTION', `Ação desconhecida: ${shown}${String(action ?? '').length > 12 ? '…' : ''}. Use: ${Object.keys(ACTIONS).join(', ')}`);
  }
  const sessionID = validateIds(action, rest, flags);
  const conn = await openApi(ctx);
  try {
    return await handler(ctx, conn.api, { flags, sessionID, rest });
  } finally {
    conn.close();
  }
}
