import { join } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, resolveModel, requireAgent, profileRules } from '../lib/context.mjs';
import { assertId } from '../lib/api.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderSession, renderSessions, renderSessionDiff, renderTodos, renderRevertPreview } from '../lib/render.mjs';
import { readSessionMessages } from '../lib/session-messages.mjs';
import { maskDeep } from '../lib/redact.mjs';

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
  if (flags.json) ctx.json(maskDeep({ session }));
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
  const safeSession = maskDeep(session);
  const safeMessages = maskDeep(messages ?? []);
  if (flags.json) ctx.json(maskDeep({ session: safeSession, status, messages: safeMessages, ...(unavailable ? { messagesUnavailable: true, reason: 'OPENCODE_LIST_BUG' } : {}) }));
  else {
    if (unavailable) ctx.out('As mensagens desta sessão não podem ser listadas por um defeito do OpenCode 1.18.32 com saída estruturada; o diff e os filhos continuam disponíveis.\n');
    ctx.out(renderSession(safeSession, { status, messages: safeMessages }));
  }
  return ExitCode.OK;
}

async function actionFork(ctx, api, { flags, sessionID, rest }) {
  const messageID = rest[1] ? assertId('msg', rest[1], 'mensagem') : undefined;
  const forked = await api.fork(sessionID, { messageID });
  if (flags.json) ctx.json(maskDeep({ session: forked, forkedFrom: { sessionID, messageID: messageID ?? null } }));
  else ctx.out(renderSession(forked, { note: `Fork de ${sessionID}${messageID ? `, com o histórico anterior a ${messageID}` : ''}.` }));
  return ExitCode.OK;
}

async function actionChildren(ctx, api, { flags, sessionID }) {
  const children = (await api.children(sessionID)) ?? [];
  if (flags.json) ctx.json(maskDeep({ sessionID, children }));
  else ctx.out(renderSessions(children, { title: `Filhas de ${sessionID}` }));
  return ExitCode.OK;
}

async function actionDiff(ctx, api, { flags, sessionID }) {
  const messageID = flags.message !== undefined ? assertId('msg', flags.message, 'mensagem') : undefined;
  const diffs = (await api.diff(sessionID, { messageID })) ?? [];
  const safeDiffs = maskDeep(diffs);
  if (flags.json) ctx.json(maskDeep({ sessionID, messageID: messageID ?? null, diffs: safeDiffs }));
  else ctx.out(renderSessionDiff(safeDiffs, { title: `Diff da sessão ${sessionID}${messageID ? ` (mensagem ${messageID})` : ''}` }));
  return ExitCode.OK;
}

async function actionTodo(ctx, api, { flags, sessionID }) {
  const todos = (await api.todo(sessionID)) ?? [];
  if (flags.json) ctx.json(maskDeep({ sessionID, todos }));
  else ctx.out(renderTodos(todos, { sessionID }));
  return ExitCode.OK;
}

const MAX_DIFF_MESSAGES = 50;
const DEFAULT_SUMMARIZE_TIMEOUT_SEC = 600;

export async function withSessionGuard(ctx, api, sessionID, fn) {
  const release = tryAcquireLock(join(ctx.stateDir, `session-${sessionID}.lock`), { purpose: 'session-op' });
  if (!release) throw new UsageError('SESSION_IN_USE', `a sessão ${sessionID} está em uso por um job ativo; aguarde (/opc:status) ou cancele (/opc:cancel)`);
  try {
    const status = (await api.sessionStatus())?.[sessionID];
    if (status && status.type !== 'idle') throw new UsageError('SESSION_BUSY', `a sessão ${sessionID} está ocupada (${status.type}); tente de novo quando ficar ociosa`);
    return await fn();
  } finally {
    release();
  }
}

export async function collectAffectedDiff(api, sessionID, messageID) {
  const messages = (await readSessionMessages(api, sessionID)) ?? [];
  if (messages.messagesUnavailable) {
    let target;
    try { target = await api.message(sessionID, messageID); }
    catch (err) {
      if (err?.code === 'NOT_FOUND') throw new UsageError('UNKNOWN_MESSAGE', `a mensagem ${messageID} não pertence à sessão ${sessionID}`);
      throw err;
    }
    if (!target) throw new UsageError('UNKNOWN_MESSAGE', `a mensagem ${messageID} não pertence à sessão ${sessionID}`);
    const diffs = (await api.diff(sessionID, { messageID })) ?? [];
    diffs.listBugNotice = 'Não foi possível enumerar os turnos posteriores por defeito do OpenCode 1.18.32; a prévia mostra apenas esta mensagem.';
    return diffs;
  }
  const index = messages.findIndex((m) => m.info?.id === messageID);
  if (index < 0) throw new UsageError('UNKNOWN_MESSAGE', `a mensagem ${messageID} não pertence à sessão ${sessionID}`);
  const target = messages[index].info;
  const ids = [];
  if (target.role === 'assistant' && target.parentID) ids.push(target.parentID);
  for (const message of messages.slice(index)) {
    if (message.info?.role === 'user' && !ids.includes(message.info.id)) ids.push(message.info.id);
  }
  const previewTruncated = ids.length > MAX_DIFF_MESSAGES;
  const byFile = new Map();
  for (const id of ids.slice(0, MAX_DIFF_MESSAGES)) {
    for (const diff of (await api.diff(sessionID, { messageID: id })) ?? []) {
      const key = diff.file ?? '(desconhecido)';
      const previous = byFile.get(key);
      if (!previous) {
        byFile.set(key, { ...diff });
        continue;
      }
      byFile.set(key, {
        ...previous,
        additions: (previous.additions ?? 0) + (diff.additions ?? 0),
        deletions: (previous.deletions ?? 0) + (diff.deletions ?? 0),
        patch: [previous.patch, diff.patch].filter(Boolean).join('\n'),
        status: previous.status === 'added' ? 'added' : (diff.status ?? previous.status),
      });
    }
  }
  const result = [...byFile.values()];
  if (previewTruncated) result.previewTruncated = true;
  return result;
}

async function actionRevert(ctx, api, { flags, sessionID, rest }) {
  if (!rest[1]) throw new UsageError('MISSING_MESSAGE_ID', 'session revert exige <sessionID> <messageID>');
  const messageID = assertId('msg', rest[1], 'mensagem');
  const partID = flags.part ? assertId('prt', flags.part, 'parte') : undefined;
  return withSessionGuard(ctx, api, sessionID, async () => {
    const affected = await collectAffectedDiff(api, sessionID, messageID);
    if (!flags['confirmed-by-user']) {
      const command = `opc session revert ${sessionID} ${messageID}${partID ? ` --part ${partID}` : ''} --confirmed-by-user`;
      if (flags.json) ctx.json(maskDeep({ confirmed: false, action: 'revert', sessionID, messageID, affected, command, ...(affected.previewTruncated ? { previewTruncated: true, notice: 'Prévia limitada às 50 mensagens do usuário mais recentes; o revert pode afetar mais arquivos.' } : {}), ...(affected.listBugNotice ? { notice: affected.listBugNotice } : {}) }));
      else ctx.out(`${renderRevertPreview({ action: 'revert', sessionID, messageID, affected, command })}${affected.previewTruncated ? '\nPrévia limitada às 50 mensagens do usuário mais recentes; o revert pode afetar mais arquivos.\n' : ''}${affected.listBugNotice ? `\n${affected.listBugNotice}\n` : ''}`);
      return ExitCode.USAGE;
    }
    const session = await api.revert(sessionID, { messageID, partID });
    if (flags.json) ctx.json(maskDeep({ confirmed: true, action: 'revert', session }));
    else ctx.out(renderSession(session, { note: `Revert aplicado a partir de ${messageID}. Para desfazer: opc session unrevert ${sessionID} --confirmed-by-user` }));
    return ExitCode.OK;
  });
}

async function actionUnrevert(ctx, api, { flags, sessionID }) {
  return withSessionGuard(ctx, api, sessionID, async () => {
    const current = await api.getSession(sessionID);
    if (!current.revert) throw new UsageError('NOT_REVERTED', `a sessão ${sessionID} não tem revert ativo; nada a desfazer`);
    if (!flags['confirmed-by-user']) {
      const command = `opc session unrevert ${sessionID} --confirmed-by-user`;
      const rawDiff = current.revert.diff ?? null;
      if (flags.json) ctx.json(maskDeep({ confirmed: false, action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command }));
      else ctx.out(renderRevertPreview({ action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command }));
      return ExitCode.USAGE;
    }
    const session = await api.unrevert(sessionID);
    if (flags.json) ctx.json(maskDeep({ confirmed: true, action: 'unrevert', session }));
    else ctx.out(renderSession(session, { note: 'Unrevert aplicado: mensagens e arquivos restaurados.' }));
    return ExitCode.OK;
  });
}

async function actionSummarize(ctx, api, { flags, sessionID }) {
  const discovery = await loadDiscovery(api);
  const model = resolveModel(ctx, discovery, 'summarize', flags.model);
  return withSessionGuard(ctx, api, sessionID, async () => {
    await api.summarize(sessionID, {
      providerID: model.providerID,
      modelID: model.modelID,
      timeoutMs: (flags.timeout ?? DEFAULT_SUMMARIZE_TIMEOUT_SEC) * 1000,
    });
    if (flags.json) ctx.json(maskDeep({ sessionID, model: model.full, summarized: true }));
    else ctx.out(`# Sessão ${sessionID} resumida\n\nModelo: ${model.full}\nVeja o resultado: opc session show ${sessionID}\n`);
    return ExitCode.OK;
  });
}

const ACTIONS = {
  new: actionNew,
  show: actionShow,
  fork: actionFork,
  revert: actionRevert,
  unrevert: actionUnrevert,
  summarize: actionSummarize,
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
