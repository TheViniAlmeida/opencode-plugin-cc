import { join } from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { ExitCode, UsageError } from '../lib/opc-error.mjs';
import { openApi, loadDiscovery, resolveModel, requireAgent, profileRules } from '../lib/context.mjs';
import { assertId } from '../lib/api.mjs';
import { tryAcquireLock } from '../lib/locks.mjs';
import { renderSession, renderSessions, renderSessionDiff, renderRevertPreview } from '../lib/render.mjs';
import { readSessionMessages, readTurnMessages } from '../lib/session-messages.mjs';
import { maskDeep, safeOutputText } from '../lib/redact.mjs';

const SPEC = {
  flags: {
    title: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string', alias: 'm' },
    write: { type: 'boolean' },
    limit: { type: 'number', default: 20 },
    part: { type: 'string' },
    message: { type: 'string' },
    before: { type: 'string' },
    'confirmed-by-user': { type: 'boolean' },
    timeout: { type: 'number' },
    json: { type: 'boolean' },
    cwd: { type: 'string' },
  },
  allowPositionals: true,
};

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
export const REVERT_SCOPE_NOTICE = 'O OpenCode 2 não fornece um diff restrito às mensagens a partir do alvo. A reversão pode alterar arquivos; confira o estado da sessão e do workspace antes de confirmar.';

async function actionNew(ctx, api, { flags }) {
  const policy = ctx.config.policy ?? {};
  const body = {
    title: `OPC: session: ${oneLine(flags.title || 'manual').slice(0, 72)}`,
    permissions: profileRules(ctx, flags.write ? 'write' : 'read-only'),
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
  const safeSession = maskDeep(session);
  const safeMessages = maskDeep(messages ?? []);
  if (flags.json) ctx.json({ session: safeSession, status, messages: safeMessages });
  else ctx.out(renderSession(safeSession, { status, messages: safeMessages }));
  return ExitCode.OK;
}

async function actionFork(ctx, api, { flags, sessionID, rest }) {
  const messageID = flags.before ? assertId('msg', flags.before, 'mensagem') : undefined;
  const forked = await api.fork(sessionID, { before: messageID });
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
  if (flags.message !== undefined) throw new UsageError('UNKNOWN_OPTION', '--message não está disponível para diff no OpenCode 2');
  const diffs = (await api.diff(sessionID)) ?? [];
  const safeDiffs = maskDeep(diffs);
  if (flags.json) ctx.json(maskDeep({ sessionID, messageID: null, source: 'session', notices: [], diffs: safeDiffs }));
  else ctx.out(renderSessionDiff(safeDiffs, { title: `Diff da sessão ${sessionID}` }));
  return ExitCode.OK;
}

const DEFAULT_SUMMARIZE_TIMEOUT_SEC = 600;

export async function withSessionGuard(ctx, api, sessionID, fn) {
  const release = tryAcquireLock(join(ctx.stateDir, `session-${sessionID}.lock`), { purpose: 'session-op' });
  if (!release) throw new UsageError('SESSION_IN_USE', `a sessão ${sessionID} está em uso por um job ativo; aguarde (/opc:status) ou cancele (/opc:cancel)`);
  try {
    const status = (await api.sessionStatus())?.[sessionID];
    if (status && status.type !== 'idle') throw new UsageError('SESSION_BUSY', `a sessão ${sessionID} está ocupada (${safeOutputText(status.type)}); tente de novo quando ficar ociosa`);
    return await fn();
  } finally {
    release();
  }
}

export async function collectAffectedDiff(api, sessionID, messageID) {
  const messages = await readTurnMessages(api, sessionID, messageID);
  if (!messages.some((message) => message.id === messageID)) {
    throw new UsageError('UNKNOWN_MESSAGE', 'a mensagem <valor> não pertence à sessão <valor>');
  }
  return null;
}

async function actionRevert(ctx, api, { flags, sessionID, rest }) {
  const requestedMessageID = flags.message ?? rest[1];
  if (!requestedMessageID) throw new UsageError('MISSING_MESSAGE_ID', 'session revert exige <sessionID> <messageID>');
  const messageID = assertId('msg', requestedMessageID, 'mensagem');
  if (flags.part) throw new UsageError('UNKNOWN_OPTION', '--part não está disponível no OpenCode 2');
  return withSessionGuard(ctx, api, sessionID, async () => {
    const affected = await collectAffectedDiff(api, sessionID, messageID);
    if (!flags['confirmed-by-user']) {
      const command = `opc session revert ${sessionID} ${messageID} --confirmed-by-user`;
      if (flags.json) ctx.json(maskDeep({ confirmed: false, action: 'revert', sessionID, messageID, affected, notice: REVERT_SCOPE_NOTICE, command }));
      else ctx.out(renderRevertPreview({ action: 'revert', sessionID, messageID, affected, notice: REVERT_SCOPE_NOTICE, command }));
      return ExitCode.USAGE;
    }
    await api.revertStage(sessionID, { messageID });
    await api.revertCommit(sessionID);
    const session = await api.getSession(sessionID);
    if (flags.json) ctx.json(maskDeep({ confirmed: true, action: 'revert', session }));
    else ctx.out(renderSession(session, { note: `Reversão aplicada. Para desfazer: opc session unrevert ${sessionID} --confirmed-by-user` }));
    return ExitCode.OK;
  });
}

async function actionUnrevert(ctx, api, { flags, sessionID }) {
  return withSessionGuard(ctx, api, sessionID, async () => {
    const current = await api.getSession(sessionID);
    if (!current.revert) throw new UsageError('NOT_REVERTED', 'a sessão <valor> não tem reversão ativa; nada a desfazer');
    if (!flags['confirmed-by-user']) {
      const command = `opc session unrevert ${sessionID} --confirmed-by-user`;
      const rawDiff = current.revert.diff ?? null;
      if (flags.json) ctx.json(maskDeep({ confirmed: false, action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command }));
      else ctx.out(renderRevertPreview({ action: 'unrevert', sessionID, messageID: current.revert.messageID, rawDiff, command }));
      return ExitCode.USAGE;
    }
    await api.revertClear(sessionID);
    const session = await api.getSession(sessionID);
    if (flags.json) ctx.json(maskDeep({ confirmed: true, action: 'unrevert', session }));
    else ctx.out(renderSession(session, { note: 'Unrevert aplicado: mensagens e arquivos restaurados.' }));
    return ExitCode.OK;
  });
}

async function actionSummarize(ctx, api, { flags, sessionID }) {
  const discovery = await loadDiscovery(api);
  const model = resolveModel(ctx, discovery, 'summarize', flags.model);
  return withSessionGuard(ctx, api, sessionID, async () => {
    await api.setModel(sessionID, { providerID: model.providerID, id: model.modelID });
    await api.compact(sessionID);
    if (flags.json) ctx.json(maskDeep({ sessionID, model: model.full, summarized: true }));
    else ctx.out(`# Sessão ${safeOutputText(sessionID)} resumida\n\nModelo: ${safeOutputText(model.full)}\nVeja o resultado: opc session show ${safeOutputText(sessionID)}\n`);
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
};

// Validates every id before connecting, so malformed input never reaches the server.
function validateIds(action, rest, flags) {
  if (action === 'new') return null;
  if (!rest[0]) throw new UsageError('MISSING_ID', `session ${action} exige <sessionID>`);
  const sessionID = assertId('ses', rest[0], 'sessão');
  if (rest[1] && action === 'revert') assertId('msg', rest[1], 'mensagem');
  if (rest[1] && action === 'fork') throw new UsageError('UNKNOWN_OPTION', 'Use --before <messageID> para bifurcar antes de uma mensagem');
  if (flags.before) assertId('msg', flags.before, 'mensagem');
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
    throw new UsageError('UNKNOWN_SUBCOMMAND', `Subcomando desconhecido: ${shown}${String(action ?? '').length > 12 ? '…' : ''}. Use: ${Object.keys(ACTIONS).join(', ')}`);
  }
  const sessionID = validateIds(action, rest, flags);
  const conn = await openApi(ctx);
  try {
    return await handler(ctx, conn.api, { flags, sessionID, rest });
  } finally {
    conn.close();
  }
}
