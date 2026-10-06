// Runs one OpenCode V2 turn until its execution ends.
import { randomBytes } from 'node:crypto';
import { classifyError, retryCapError, retryExceedsCap } from './errors.mjs';
import { ConnectionError, OpcError, UsageError } from './opc-error.mjs';
import { toPermissionRequest, toQuestion } from './opencode-v2.mjs';
import { redactText, safeOutputText, redactOutput } from './redact.mjs';
import { readSessionMessages, readTurnMessages } from './session-messages.mjs';
import { extractTextJson } from './text-json.mjs';
import { jsonInstruction, schemaValidator } from './structured-text.mjs';
import { validateReviewOutput } from './render.mjs';

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STATUS_POLL_MS = 5000;
const DEFAULT_IDLE_WAIT_MS = 10000;
const INVESTIGATE_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch']);
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch']);
const VERIFY_RE = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;
const ERROR_CODES = { Timeout: 'turn_timeout', RetryCapExceeded: 'retry_cap', BadRequest: 'bad_request' };
let lastIdMs = 0;
let idCounter = 0;

export function newMessageId(now = Date.now()) {
  if (now !== lastIdMs) { lastIdMs = now; idCounter = 0; }
  idCounter += 1;
  const value = BigInt(now) * 4096n + BigInt(idCounter);
  const head = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) head[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const random = randomBytes(14);
  let tail = '';
  for (let i = 0; i < 14; i += 1) tail += ID_ALPHABET[random[i] % 62];
  return `msg_${head.toString('hex')}${tail}`;
}

const shown = (value) => {
  const text = safeOutputText(value) ?? '';
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
};

export function phaseFromPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'tool') {
    const tool = part.name;
    if (INVESTIGATE_TOOLS.has(tool)) return 'investigating';
    if (EDIT_TOOLS.has(tool)) return 'editing';
    if (tool === 'subagent') return 'subagent';
    if (tool === 'shell') return VERIFY_RE.test(String(part.state?.input?.command ?? '')) ? 'verifying' : 'running';
    return 'running';
  }
  return part.type === 'text' || part.type === 'reasoning' ? 'running' : null;
}

export function toolErrorSummary(error) {
  const text = safeOutputText(error?.message ?? error).split('\n')[0].replace(/\s*Here are some of the relevant rules\b.*$/s, '').trim();
  return shown(text);
}

export function filesFromToolPart(part) {
  const input = part.state?.input ?? {};
  const files = [];
  for (const key of ['path', 'filePath']) if (typeof input[key] === 'string') files.push(input[key]);
  return files;
}

export function turnMessages(messages, messageID) {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.findIndex((message) => message?.id === messageID);
  if (index < 0) return [];
  const end = list.findIndex((message, i) => i > index && message?.type === 'idle');
  return list.slice(index + 1, end < 0 ? undefined : end + 1);
}

export function extractTurn(turn, { childMessages = [], diffs = [] } = {}) {
  const assistants = turn.filter((message) => message?.type === 'assistant');
  const last = assistants.at(-1);
  const lastWithText = [...assistants].reverse().find((message) => message.content?.some((part) => part?.type === 'text' && typeof part.text === 'string'));
  const finalText = (lastWithText?.content ?? []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
  const rawError = last?.error;
  const error = rawError ? { name: rawError.type ?? rawError.name ?? 'UnknownError', data: { message: rawError.message ?? rawError.data?.message ?? '' } } : null;
  const completed = [...assistants, ...childMessages.filter((message) => message?.type === 'assistant')]
    .flatMap((message) => message.content ?? [])
    .filter((part) => part?.type === 'tool' && part.state?.status === 'completed');
  const toolNames = [...new Set(completed.map((part) => part.name).filter(Boolean))];
  const touched = new Set();
  for (const part of completed) if (EDIT_TOOLS.has(part.name)) for (const file of filesFromToolPart(part)) touched.add(file);
  for (const diff of Array.isArray(diffs) ? diffs : []) if (typeof diff?.file === 'string') touched.add(diff.file);
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of assistants) {
    const tokens = message.tokens ?? {};
    usage.input += tokens.input ?? 0;
    usage.output += tokens.output ?? 0;
    usage.reasoning += tokens.reasoning ?? 0;
    usage.cacheRead += tokens.cache?.read ?? 0;
    usage.cacheWrite += tokens.cache?.write ?? 0;
    usage.cost += message.cost ?? 0;
  }
  return { finalText, structured: null, error, touchedFiles: [...touched].sort(), toolsRan: completed.length > 0, toolNames, usage };
}

const isServerDown = (err) => err instanceof ConnectionError && err.code === 'SERVER_DOWN';
const isTimeout = (err) => err?.code === 'TIMEOUT';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPrompt(api, sessionID, body) {
  try { await api.prompt(sessionID, body); }
  catch (err) {
    if (!isTimeout(err)) throw err;
    await api.prompt(sessionID, body);
  }
}

async function applyPermissionPatch(api, sessionID, rules) {
  await api.setPermissions(sessionID, rules);
  const updated = await api.getSession(sessionID);
  if (JSON.stringify(updated?.permissions) !== JSON.stringify(rules)) throw new OpcError('PROFILE_SWITCH_FAILED', 'Não foi possível confirmar as regras de permissão da sessão.');
}

function serverLostResult(sessionID, messageID) {
  return {
    sessionID, messageID, assistantMessageIDs: [], childSessionIDs: [], status: 'failed', errorClass: 'fatal', errorType: 'ServerLost', errorCode: 'server_lost',
    errorMessage: `Servidor OpenCode desconectado durante o turno; sessão ${shown(sessionID)} preservada. Continue com --resume <valor>`,
    finalText: '', structured: null, structuredSource: null, error: null, touchedFiles: [], toolsRan: false, toolNames: [], usage: null,
  };
}

async function waitIdle(api, sessionID, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    try { if (!((await api.sessionStatus())?.[sessionID])) return true; }
    catch { return false; }
    await sleep(250);
  }
  return false;
}

function modelFor(request) {
  return { providerID: request.model.providerID, id: request.model.modelID, ...(request.variant ? { variant: request.variant } : {}) };
}

export async function runTurn({
  api, hub, request, onProgress = () => {}, onSession = async () => {},
  onPermission = async () => {}, onQuestion = async () => {}, onRequestResolved = async () => {},
  isCancelled = () => false, signal,
} = {}) {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statusPollMs = request.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  const idleWaitMs = request.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS;
  const messageID = request.messageID ?? newMessageId();
  const progress = (event) => { try { onProgress(event); } catch { /* Progress is advisory. */ } };
  const model = modelFor(request);
  const wantedAgent = request.agent ?? request.newSession?.agent ?? 'build';
  let sessionID = request.sessionID ?? null;
  try {
    if (sessionID) {
      const current = await api.getSession(sessionID);
      if (request.patchPermission) await applyPermissionPatch(api, sessionID, request.patchPermission);
      if (current?.model?.providerID !== model.providerID || current?.model?.id !== model.id || (request.variant && current?.model?.variant !== model.variant)) await api.setModel(sessionID, model);
      if (current?.agent !== wantedAgent) await api.setAgent(sessionID, wantedAgent);
    } else {
      const { permission, ...newSession } = request.newSession ?? {};
      const created = await api.createSession({ ...newSession, model, agent: wantedAgent, permissions: newSession.permissions ?? permission });
      sessionID = created.id;
    }
  } catch (err) {
    if (isServerDown(err)) return serverLostResult(sessionID, messageID);
    throw err;
  }

  const assistantIDs = new Set();
  const rememberAssistant = (id) => {
    if (!id || assistantIDs.has(id)) return;
    assistantIDs.add(id);
    progress({ assistantMessageID: id });
  };
  progress({ phase: 'starting', sessionID, message: `Sessão ${shown(sessionID)}` });
  const tracked = new Set([sessionID]);
  const children = new Set();
  const seenRequests = new Set();
  const seenCalls = new Set();
  const toolNamesById = new Map();
  let toolsRanLive = false;
  let promptAccepted = false;
  let forcedError = null;
  let lastPhase = 'starting';
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = (reason, extra = {}) => {
    if (settled) return;
    settled = true;
    resolveDone({ reason, ...extra });
  };
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      if (isServerDown(err)) finish('server-lost');
      else finish('resync-failed', { detail: err });
    });
    return queue;
  };
  const setPhase = (phase, message) => {
    if (!phase) return;
    if (phase !== lastPhase) { lastPhase = phase; progress({ phase, message }); }
    else if (message) progress({ message });
  };
  const addChild = async (id) => {
    if (settled || !id || tracked.has(id)) return;
    tracked.add(id); children.add(id);
    setPhase('subagent', `Sessão filha ${shown(id)}`);
    try { await onSession({ sessionID, childSessionIDs: [...children] }); }
    catch (err) { finish('callback-failed', { detail: err }); }
  };
  const handlePermission = async (req) => {
    if (settled || !req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    progress({ message: `Permissão solicitada (${shown(req.id)}): ${shown(req.permission)}` });
    try { await onPermission(req); seenRequests.add(req.id); }
    catch (err) { finish('callback-failed', { detail: err }); }
  };
  const handleQuestion = async (req) => {
    if (settled || !req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    progress({ message: `Pergunta solicitada (${shown(req.id)})` });
    try { await onQuestion(req); seenRequests.add(req.id); }
    catch (err) { finish('callback-failed', { detail: err }); }
  };
  const handleResolved = async (event) => {
    try { await onRequestResolved(event); }
    catch (err) { finish('callback-failed', { detail: err }); }
  };
  const handleRetryStatus = async (status) => {
    setPhase('retrying', `Nova tentativa (${shown(status.attempt)}): ${shown(status.message ?? '')}`);
    if (forcedError || !retryExceedsCap(status, request.fallbackCfg ?? {})) return;
    forcedError = { name: 'AbortUnconfirmed', data: { message: 'Não foi possível confirmar a interrupção da sessão; fallback bloqueado.' } };
    try {
      if (await api.interrupt(sessionID) === true && await waitIdle(api, sessionID, idleWaitMs)) forcedError = retryCapError(status);
    } catch { /* Keep fail-closed error. */ }
    finish('forced-error');
  };
  const resync = async () => {
    if (settled) return;
    const statuses = await api.sessionStatus();
    for (const child of (await api.children(sessionID)) ?? []) await addChild(child?.id);
    for (const id of tracked) {
      for (const req of (await api.listPermissions(id)) ?? []) await handlePermission(req);
      for (const req of (await api.listQuestions(id)) ?? []) if (req) await handleQuestion(req);
    }
    if (statuses?.[sessionID]) return;
    const turn = turnMessages(await readTurnMessages(api, sessionID, messageID), messageID);
    for (const message of turn) if (message.type === 'assistant') rememberAssistant(message.id);
    const idle = turn.find((message) => message.type === 'idle');
    if (idle?.outcome === 'succeeded') finish('idle');
    else if (idle?.outcome === 'failed') {
      const lastError = turn.filter((message) => message.type === 'assistant').at(-1)?.error;
      finish('session-error', { error: lastError ?? { type: 'execution.failed', message: 'A execução falhou.' } });
    } else if (idle?.outcome === 'interrupted') finish('interrupted');
  };
  const onEvent = (event) => enqueue(async () => {
    if (settled || !event?.type) return;
    const data = event.data ?? {};
    switch (event.type) {
      case 'session.created':
        if (data.parentID && tracked.has(data.parentID)) await addChild(data.sessionID);
        break;
      case 'session.execution.started':
        if (data.sessionID === sessionID) setPhase('running');
        break;
      case 'session.execution.succeeded':
        if (data.sessionID === sessionID) finish('idle');
        break;
      case 'session.execution.failed':
        if (data.sessionID === sessionID) finish('session-error', { error: data.error ?? { type: 'execution.failed', message: 'A execução falhou.' } });
        break;
      case 'session.execution.interrupted':
        if (data.sessionID === sessionID) finish('interrupted');
        break;
      case 'session.step.started':
        if (data.sessionID === sessionID) rememberAssistant(data.assistantMessageID);
        break;
      case 'session.tool.input.started':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed': {
        if (!tracked.has(data.sessionID)) break;
        if (event.type === 'session.tool.success') toolsRanLive = true;
        const key = data.id;
        if (event.type === 'session.tool.input.started' && data.name) toolNamesById.set(key, data.name);
        if (event.type === 'session.tool.input.started' || event.type === 'session.tool.called') {
          const first = !seenCalls.has(key);
          seenCalls.add(key);
          const name = data.name ?? toolNamesById.get(key);
          const phase = phaseFromPart({ type: 'tool', name, state: { input: data.input } });
          setPhase(phase, first ? `Ferramenta ${shown(name)}` : undefined);
        } else if (event.type === 'session.tool.failed') progress({ message: `Falha na ferramenta: ${toolErrorSummary(data.error)}` });
        break;
      }
      case 'session.text.delta':
        if (data.sessionID === sessionID) setPhase('running');
        break;
      case 'session.retry.scheduled':
        if (data.sessionID === sessionID) await handleRetryStatus({ attempt: data.attempt, message: data.error?.message, next: data.at });
        break;
      case 'permission.asked':
        await handlePermission(toPermissionRequest(data));
        break;
      case 'form.created':
        if (data.form) await handleQuestion(toQuestion(data.form));
        break;
      case 'permission.replied':
        if (tracked.has(data.sessionID)) await handleResolved({ type: 'permission', requestID: data.requestID, sessionID: data.sessionID, outcome: data.reply });
        break;
      case 'form.replied':
      case 'form.cancelled':
        if (tracked.has(data.sessionID)) await handleResolved({ type: 'question', requestID: data.id, sessionID: data.sessionID, outcome: event.type === 'form.replied' ? 'replied' : 'rejected' });
        break;
      default:
    }
  });

  const untrack = hub.track(sessionID, onEvent);
  // V2 form.created carries sessionID inside data.form, so the hub's session route cannot see it.
  const offForms = hub.onAny?.((event) => { if (event?.type === 'form.created') onEvent(event); }) ?? (() => {});
  const offReconnect = hub.onReconnect(() => enqueue(resync));
  const timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);
  let pollTimer = null;
  const onAbort = () => finish('cancelled');
  if (signal?.aborted) finish('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      try { await onSession({ sessionID, childSessionIDs: [] }); }
      catch (err) { finish('callback-failed', { detail: err }); }
      if (!settled && (signal?.aborted || isCancelled())) finish('cancelled');
      if (!settled) {
        const text = (request.parts ?? []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n');
        const promptText = request.format?.type === 'json_schema' ? `${text}\n\n${jsonInstruction(request.format.schema)}` : text;
        await sendPrompt(api, sessionID, { id: messageID, text: promptText });
        promptAccepted = true;
      }
    } catch (err) {
      if (isServerDown(err)) finish('server-lost');
      else if (err instanceof OpcError && err.code === 'BAD_REQUEST') finish('prompt-failed', { error: { name: 'BadRequest', data: { message: 'A requisição do turno foi rejeitada.' } } });
      else throw err;
    }
    if (!settled) pollTimer = setInterval(() => enqueue(resync), statusPollMs);
    const outcome = await done;
    return await buildResult(outcome);
  } finally {
    clearInterval(pollTimer); clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', onAbort);
    untrack(); offForms(); offReconnect();
  }

  async function buildResult(outcome) {
    const base = { sessionID, messageID, assistantMessageIDs: [...assistantIDs], childSessionIDs: [...children] };
    if (outcome.reason === 'cancelled' && !promptAccepted) {
      try { await api.interrupt(sessionID); } catch { /* Best effort. */ }
      return { ...base, ...extractTurn([]), structuredSource: null, status: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorCode: 'cancelled', errorMessage: 'Turno cancelado' };
    }
    const safetyFailure = outcome.reason === 'callback-failed' || outcome.reason === 'resync-failed';
    if (safetyFailure) {
      const sessionAborts = [];
      for (const id of [...tracked].reverse()) {
        let aborted = false;
        try { aborted = await api.interrupt(id) === true; } catch { /* Unconfirmed. */ }
        sessionAborts.push({ sessionID: id, aborted, idle: false });
      }
      await Promise.all(sessionAborts.map(async (entry) => { entry.idle = await waitIdle(api, entry.sessionID, idleWaitMs); }));
      base.sessionAborts = sessionAborts;
      base.abortConfirmed = sessionAborts.every((entry) => entry.aborted && entry.idle);
    }
    const serverLost = () => ({ ...serverLostResult(sessionID, messageID), ...base, toolsRan: toolsRanLive });
    if (outcome.reason === 'server-lost') return serverLost();
    if (outcome.reason === 'resync-failed') {
      const message = `Falha ao sincronizar o turno: ${safeOutputText(outcome.detail?.message).replace(/[\r\n]+/g, ' ').slice(0, 500)}`;
      return { ...base, ...extractTurn([]), structuredSource: null, status: 'failed', errorClass: 'fatal', errorType: 'ResyncError', errorCode: outcome.detail?.code ?? 'RESYNC_FAILED', errorMessage: message, error: { name: 'ResyncError', data: { message } } };
    }
    if (outcome.reason === 'timeout' || outcome.reason === 'cancelled') {
      try { await api.interrupt(sessionID); }
      catch (err) { if (isServerDown(err)) return serverLost(); }
      await waitIdle(api, sessionID, idleWaitMs);
    }
    let collected;
    try {
      const messages = await readTurnMessages(api, sessionID, messageID);
      if (outcome.reason === 'idle' && !messages.some((message) => message?.id === messageID)) {
        return { ...base, ...extractTurn([]), structuredSource: null, status: 'failed', errorClass: 'fatal', errorType: 'TurnMessageNotFound', errorCode: 'TURN_MESSAGE_NOT_FOUND', errorMessage: 'A mensagem do turno não foi encontrada na sessão.', error: { name: 'TurnMessageNotFound', data: { message: 'A mensagem do turno não foi encontrada na sessão.' } } };
      }
      const childMessages = [];
      for (const child of children) childMessages.push(...((await readSessionMessages(api, child)) ?? []));
      let diffs = [];
      try { diffs = (await api.diff(sessionID)) ?? []; }
      catch (err) { if (isServerDown(err)) throw err; }
      collected = extractTurn(turnMessages(messages, messageID), { childMessages, diffs });
      for (const message of turnMessages(messages, messageID)) if (message.type === 'assistant') rememberAssistant(message.id);
    } catch (err) {
      if (!safetyFailure) { if (isServerDown(err)) return serverLost(); throw err; }
      collected = extractTurn([]);
    }
    const textJson = request.format?.type === 'json_schema' ? schemaValidator(request.format.schema)
      : request.textJson ?? (['review', 'adversarial-review'].includes(request.kind) ? validateReviewOutput : request.kind === 'task' ? () => null : null);
    if (outcome.reason === 'idle' && !collected.error && !forcedError && typeof textJson === 'function') collected.structured = extractTextJson(collected.finalText, textJson);
    collected = redactOutput({ ...collected, structuredSource: collected.structured === null ? null : 'text' });
    const toolsRan = collected.toolsRan || toolsRanLive;
    const result = { ...base, ...collected, toolsRan };
    if (forcedError?.name === 'AbortUnconfirmed') return { ...result, status: 'failed', error: forcedError, errorClass: 'fatal', errorType: 'AbortUnconfirmed', errorCode: 'ABORT_UNCONFIRMED', errorMessage: forcedError.data.message };
    if (outcome.reason === 'callback-failed') return { ...result, status: 'failed', errorClass: 'fatal', errorType: 'CallbackFailed', errorCode: 'CALLBACK_FAILED', errorMessage: `O callback do turno falhou: ${shown(outcome.detail?.message)}` };
    if (outcome.reason === 'forced-error' && forcedError) {
      const classified = classifyError(forcedError, { toolsRan });
      return { ...result, status: 'failed', error: forcedError, errorClass: classified.errorClass, errorType: classified.errorType, errorMessage: classified.message, errorCode: ERROR_CODES[classified.errorType] ?? 'model_error' };
    }
    if (outcome.reason === 'cancelled' || outcome.reason === 'interrupted') return { ...result, status: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorCode: 'cancelled', errorMessage: 'Turno cancelado' };
    let error = collected.error;
    if (outcome.reason === 'timeout') error = { name: 'Timeout', data: { message: `O turno excedeu ${timeoutMs} ms e foi interrompido` } };
    else if (outcome.reason === 'session-error') error = { name: outcome.error?.type ?? outcome.error?.name ?? 'execution.failed', data: { message: outcome.error?.message ?? 'A execução falhou.' } };
    else if (outcome.reason === 'prompt-failed') error = outcome.error;
    if (!error) return { ...result, status: 'completed', error: null };
    const classified = classifyError(error, { toolsRan });
    if (classified.errorType === 'aborted') return { ...result, status: 'cancelled', error: { name: 'aborted', data: { message: classified.message } }, errorClass: 'fatal', errorType: 'aborted', errorMessage: classified.message, errorCode: 'cancelled' };
    return { ...result, status: 'failed', error: { name: classified.errorType, data: { message: classified.message } }, errorClass: classified.errorClass, errorType: classified.errorType, errorMessage: classified.message, errorCode: ERROR_CODES[classified.errorType] ?? 'model_error' };
  }
}
// --- F3: subagents ------------------------------------------------------------------
export const SUBAGENT_MECHANISMS = Object.freeze(['child-session', 'subtask']);

export function isAgentModeRefusal(errOrResult) {
  if (!errOrResult) return false;
  const text = typeof errOrResult === 'string'
    ? errOrResult
    : [errOrResult.message, errOrResult.errorMessage, errOrResult.errorType, errOrResult.details ? JSON.stringify(errOrResult.details) : '']
      .filter(Boolean).join(' ');
  return /\bagent\b/i.test(text) && /(subagent|primary|\bmode\b)/i.test(text);
}

export function extractTaskOutput(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (part.type === 'tool' && part.tool === 'task' && part.state?.status === 'completed' && typeof part.state.output === 'string') {
        return part.state.output;
      }
    }
  }
  return '';
}

// Runs one subagent member. Default: a child session with the agent (spec §13.3 F3).
// If OpenCode refuses a subagent-mode agent as session agent (§15 item 7), falls back to a
// `subtask` part sent to a carrier child session (one carrier per member: one prompt per session).
export async function dispatchSubagent({
  api, hub, parentSessionID, member, prompt, rules, mechanism = 'child-session', allowFallback = true,
  timeoutMs, fallbackCfg, onSession = () => {}, onProgress = () => {}, onPermission = async () => {},
  onQuestion = async () => {}, onRequestResolved = async () => {}, signal, runTurnImpl = runTurn,
}) {
  if (!SUBAGENT_MECHANISMS.includes(mechanism)) {
    const value = String(mechanism ?? '');
    const shown = value.length > 12 ? `${value.slice(0, 12)}…` : value;
    throw new UsageError('INVALID_MECHANISM', `Mecanismo inválido: ${shown} (use ${SUBAGENT_MECHANISMS.join(' ou ')})`);
  }
  // onRequestResolved is forwarded to runTurn so the F2a request bridge (bridge.onResolved) releases pending requests.
  const common = { api, hub, onProgress, onPermission, onQuestion, onRequestResolved, signal };
  const baseRequest = { model: member.model, variant: member.variant, timeoutMs, fallbackCfg };

  const viaSubtask = async (fellBack) => {
    const carrier = await api.createSession({
      parentID: parentSessionID,
      title: `${member.title} (subtask)`,
      permission: [...rules, { permission: 'task', pattern: member.agent, action: 'allow' }],
    });
    await onSession(carrier.id);
    const result = await runTurnImpl({
      ...common,
      request: {
        ...baseRequest,
        sessionID: carrier.id,
        messageID: newMessageId(),
        parts: [{ type: 'subtask', prompt, description: member.title, agent: member.agent, model: member.model }],
      },
    });
    let finalText = result.finalText;
    // task tool output is model-derived raw text: read through the list-bug-aware reader and mask it like runTurn's finalText
    if (!finalText && result.status === 'completed') finalText = safeOutputText(extractTaskOutput(await readSessionMessages(api, carrier.id)));
    return { ...result, finalText, mechanism: 'subtask', fellBack, carrierSessionID: carrier.id };
  };

  if (mechanism === 'subtask') return viaSubtask(false);

  let child;
  try {
    child = await api.createSession({ parentID: parentSessionID, title: member.title, agent: member.agent, permission: rules });
  } catch (err) {
    if (allowFallback && isAgentModeRefusal(err)) return viaSubtask(true);
    throw err;
  }
  await onSession(child.id);
  let result;
  try {
    result = await runTurnImpl({
      ...common,
      request: { ...baseRequest, sessionID: child.id, messageID: newMessageId(), agent: member.agent, parts: [{ type: 'text', text: prompt }] },
    });
  } catch (err) {
    if (allowFallback && isAgentModeRefusal(err)) return viaSubtask(true);
    throw err;
  }
  if (result.status === 'failed' && allowFallback && isAgentModeRefusal(result)) return viaSubtask(true);
  return { ...result, mechanism: 'child-session', fellBack: false };
}
