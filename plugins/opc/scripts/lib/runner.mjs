// Runs one OpenCode turn (prompt_async + SSE) until it ends (spec §7). Knows nothing about
// commands, jobs or rendering: the caller wires progress, permissions and questions.
import { randomBytes } from 'node:crypto';
import { classifyError, retryExceedsCap } from './errors.mjs';
import { ConnectionError, OpcError } from './opc-error.mjs';
import { endsWithRules } from './policy.mjs';
import { redactText } from './redact.mjs';

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STATUS_POLL_MS = 5000;
const DEFAULT_IDLE_WAIT_MS = 10000;
const INVESTIGATE_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'lsp', 'webfetch', 'websearch', 'codesearch']);
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit']);
// OpenCode registers json_schema output as a tool named StructuredOutput (binary 1.18.32): it is
// the answer itself, not a side effect, so it never counts as "tools ran".
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const VERIFY_RE = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;
const ERROR_CODES = { Timeout: 'turn_timeout', RetryCapExceeded: 'retry_cap', BadRequest: 'bad_request' };

let lastIdMs = 0;
let idCounter = 0;

// Same layout as OpenCode's Identifier.ascending (binary 1.18.32): prefix_ + 12 hex + 14 base62.
export function newMessageId(now = Date.now()) {
  if (now !== lastIdMs) {
    lastIdMs = now;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(now) * 4096n + BigInt(idCounter);
  const head = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) head[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const random = randomBytes(14);
  let tail = '';
  for (let i = 0; i < 14; i += 1) tail += ID_ALPHABET[random[i] % 62];
  return `msg_${head.toString('hex')}${tail}`;
}

export function phaseFromPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'tool') {
    const tool = String(part.tool ?? '');
    if (tool === STRUCTURED_OUTPUT_TOOL) return 'finalizing';
    if (INVESTIGATE_TOOLS.has(tool)) return 'investigating';
    if (EDIT_TOOLS.has(tool)) return 'editing';
    if (tool === 'task') return 'subagent';
    if (tool === 'bash') return VERIFY_RE.test(String(part.state?.input?.command ?? '')) ? 'verifying' : 'running';
    return 'running';
  }
  if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') return 'running';
  return null;
}

function toolArg(part) {
  const input = part.state?.input ?? {};
  const raw = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.description ?? '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return displayValue(text);
}

function displayValue(value) {
  const text = redactText(String(value ?? ''));
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

export function filesFromToolPart(part) {
  const input = part.state?.input ?? {};
  const files = [];
  for (const key of ['filePath', 'path', 'file']) if (typeof input[key] === 'string') files.push(input[key]);
  const patch = input.patchText ?? input.patch;
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(match[1].trim());
  }
  const metaFiles = part.state?.metadata?.files;
  if (Array.isArray(metaFiles)) {
    for (const f of metaFiles) {
      if (typeof f === 'string') files.push(f);
      else if (typeof f?.filePath === 'string') files.push(f.filePath);
    }
  }
  return files;
}

export function turnMessages(messages, messageID) {
  const list = Array.isArray(messages) ? messages : [];
  const byParent = list.filter((m) => m?.info?.role === 'assistant' && m.info.parentID === messageID);
  if (byParent.length > 0) return byParent;
  const index = list.findIndex((m) => m?.info?.id === messageID);
  return index >= 0 ? list.slice(index + 1).filter((m) => m?.info?.role === 'assistant') : [];
}

function textOf(message) {
  return (message?.parts ?? [])
    .filter((p) => p?.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function extractTurn(turn, { childMessages = [], diffs = [] } = {}) {
  let finalText = '';
  for (let i = turn.length - 1; i >= 0 && !finalText; i -= 1) finalText = textOf(turn[i]);
  let structured = null;
  for (const m of turn) if (m.info?.structured !== undefined && m.info.structured !== null) structured = m.info.structured;
  const error = [...turn].reverse().find((m) => m.info?.error)?.info.error ?? null;
  const toolParts = [...turn, ...childMessages].flatMap((m) => m?.parts ?? []).filter((p) => p?.type === 'tool' && p.tool !== STRUCTURED_OUTPUT_TOOL);
  const completed = toolParts.filter((p) => p.state?.status === 'completed');
  const touched = new Set();
  for (const part of completed) if (EDIT_TOOLS.has(part.tool)) for (const file of filesFromToolPart(part)) touched.add(file);
  for (const d of Array.isArray(diffs) ? diffs : []) if (typeof d?.file === 'string') touched.add(d.file);
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of turn) {
    const t = m.info?.tokens;
    if (t) {
      usage.input += t.input ?? 0;
      usage.output += t.output ?? 0;
      usage.reasoning += t.reasoning ?? 0;
      usage.cacheRead += t.cache?.read ?? 0;
      usage.cacheWrite += t.cache?.write ?? 0;
    }
    usage.cost += m.info?.cost ?? 0;
  }
  return { finalText, structured, error, touchedFiles: [...touched].sort(), toolsRan: completed.length > 0, usage };
}

const isServerDown = (err) => err instanceof ConnectionError && err.code === 'SERVER_DOWN';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPrompt(api, sessionID, body) {
  try {
    await api.promptAsync(sessionID, body);
  } catch (err) {
    if (!(err instanceof ConnectionError) || err.code !== 'TIMEOUT') throw err;
    // spec §5.2: resend only after confirming the messageID did not arrive
    const messages = await api.messages(sessionID, { limit: 50 });
    if (Array.isArray(messages) && messages.some((m) => m?.info?.id === body.messageID)) return;
    await api.promptAsync(sessionID, body);
  }
}

async function applyPermissionPatch(api, sessionID, rules) {
  const updated = await api.patchSession(sessionID, { permission: rules });
  if (!endsWithRules(updated?.permission ?? [], rules)) {
    throw new OpcError('PROFILE_SWITCH_FAILED', 'PATCH /session não aplicou as regras de permissão');
  }
}

function serverLostResult(sessionID, messageID) {
  return {
    sessionID, messageID, childSessionIDs: [], status: 'failed', errorClass: 'fatal', errorType: 'ServerLost', errorCode: 'server_lost',
    errorMessage: `Servidor OpenCode desconectado durante o turno; sessão ${displayValue(sessionID)} preservada. Continue com --resume <valor>`,
    finalText: '', structured: null, error: null, touchedFiles: [], toolsRan: false, usage: null,
  };
}

async function waitIdle(api, sessionID, maxMs) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    try {
      const statuses = await api.sessionStatus();
      const own = statuses?.[sessionID];
      if (!own || own.type === 'idle') return true;
    } catch (err) {
      if (isServerDown(err)) return false;
    }
    await sleep(250);
  }
  return false;
}

function buildBody(request, messageID) {
  const body = { messageID, model: { providerID: request.model.providerID, modelID: request.model.modelID }, parts: request.parts };
  if (request.agent) body.agent = request.agent;
  if (request.variant) body.variant = request.variant;
  if (request.format) body.format = request.format;
  return body;
}

export async function runTurn({
  api,
  hub,
  request,
  onProgress = () => {},
  onPermission = async () => {},
  onQuestion = async () => {},
  onRequestResolved = async () => {},
  signal,
} = {}) {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const statusPollMs = request.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  const idleWaitMs = request.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS;
  const messageID = request.messageID ?? newMessageId();
  const progress = (event) => {
    try {
      onProgress(event);
    } catch {
      // progress reporting must never break the turn
    }
  };

  let sessionID = request.sessionID ?? null;
  try {
    if (sessionID) {
      if (request.patchPermission) await applyPermissionPatch(api, sessionID, request.patchPermission);
    } else {
      const created = await api.createSession(request.newSession ?? {});
      sessionID = created.id;
    }
  } catch (err) {
    if (isServerDown(err)) return serverLostResult(sessionID, messageID);
    throw err;
  }
  progress({ phase: 'starting', sessionID, message: `Sessão ${displayValue(sessionID)}` });

  const tracked = new Set([sessionID]);
  const children = new Set();
  const seenRequests = new Set();
  const loggedCalls = new Set();
  let sawBusy = false;
  let toolsRanLive = false;
  let lastPhase = 'starting';
  let forcedError = null;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = (reason, extra = {}) => {
    if (settled) return;
    settled = true;
    resolveDone({ reason, ...extra });
  };
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      if (isServerDown(err)) finish('server-lost');
      else progress({ message: `Erro ao processar evento: ${displayValue(err.message)}` });
    });
    return queue;
  };
  const setPhase = (phase, message) => {
    if (!phase || phase === lastPhase) {
      if (message) progress({ message });
      return;
    }
    lastPhase = phase;
    progress({ phase, message });
  };

  const addChild = async (childID) => {
    if (!childID || tracked.has(childID)) return;
    tracked.add(childID);
    children.add(childID);
    lastPhase = 'subagent';
    progress({ phase: 'subagent', childSessionID: childID, message: `Sessão filha ${displayValue(childID)}` });
    if (request.childPermission) {
      try {
        await applyPermissionPatch(api, childID, request.childPermission);
      } catch (err) {
        finish('child-permission-failed', { detail: err });
      }
    }
  };

  const handlePermission = async (req) => {
    if (!req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    progress({ message: `Permissão solicitada (${displayValue(req.id)}): ${displayValue(req.permission)} ${(req.patterns ?? []).map(displayValue).join(' ')}`.trim() });
    try {
      await onPermission(req);
      seenRequests.add(req.id);
    } catch (err) {
      finish('callback-failed', { detail: err });
    }
  };
  const handleQuestion = async (req) => {
    if (!req?.id || seenRequests.has(req.id) || !tracked.has(req.sessionID)) return;
    progress({ message: `Pergunta solicitada (${displayValue(req.id)}): ${(req.questions ?? []).map((q) => displayValue(q.header ?? q.question)).join(' | ')}` });
    try {
      await onQuestion(req);
      seenRequests.add(req.id);
    } catch (err) {
      finish('callback-failed', { detail: err });
    }
  };

  const checkFinished = async () => {
    if (settled) return;
    const messages = await api.messages(sessionID, { limit: 200 });
    const turn = turnMessages(messages, messageID);
    if (turn.some((m) => m.info?.role === 'assistant' && m.info?.parentID === messageID && m.info?.time?.completed)) return finish('idle');
    if (sawBusy) {
      const resynced = await api.messages(sessionID, { limit: 200 });
      const recovered = turnMessages(resynced, messageID);
      if (recovered.some((m) => m.info?.role === 'assistant' && m.info?.parentID === messageID && m.info?.time?.completed)) return finish('idle');
      return finish('no-assistant-message');
    }
    // idle before any activity of this turn: stale status, keep waiting
  };

  const onEvent = (event) =>
    enqueue(async () => {
      if (settled || !event || typeof event.type !== 'string') return;
      const props = event.properties ?? {};
      switch (event.type) {
        case 'session.created':
          if (props.info?.parentID && tracked.has(props.info.parentID)) await addChild(props.info.id ?? props.sessionID);
          return;
        case 'session.status': {
          if (props.sessionID !== sessionID) return;
          const status = props.status ?? {};
          if (status.type === 'busy') {
            sawBusy = true;
            if (lastPhase === 'starting') setPhase('running');
          } else if (status.type === 'retry') {
            sawBusy = true;
            await handleRetryStatus(status);
          } else if (status.type === 'idle') {
            await checkFinished();
          }
          return;
        }
        case 'session.idle':
          if (props.sessionID === sessionID) await checkFinished();
          return;
        case 'session.error':
          if (props.sessionID === sessionID && props.error) finish('session-error', { error: props.error });
          return;
        case 'message.updated':
          if (props.sessionID === sessionID && props.info?.role === 'assistant' && props.info.parentID === messageID) {
            sawBusy = true;
            if (props.info.time?.completed) setPhase('finalizing');
          }
          return;
        case 'message.part.updated': {
          const part = props.part;
          const owner = props.sessionID ?? part?.sessionID;
          if (!part || !tracked.has(owner)) return;
          if (owner === sessionID) sawBusy = true;
          if (part.type === 'tool') {
            const status = part.state?.status;
            if (status === 'completed' && part.tool !== STRUCTURED_OUTPUT_TOOL) toolsRanLive = true;
            const key = String(part.callID ?? part.id);
            if (!loggedCalls.has(key)) {
              loggedCalls.add(key);
              const phase = phaseFromPart(part);
              const arg = toolArg(part);
              if (phase) lastPhase = phase;
              progress({ phase, message: `${part.tool}${arg ? `: ${arg}` : ''}` });
            } else if (status === 'error') {
              progress({ message: `Falha na ferramenta ${displayValue(part.tool)}: ${displayValue(part.state?.error ?? '')}` });
            }
            return;
          }
          if (lastPhase === 'starting') setPhase(phaseFromPart(part));
          return;
        }
        case 'permission.asked':
          await handlePermission(props);
          return;
        case 'question.asked':
          await handleQuestion(props);
          return;
        case 'permission.replied':
          if (tracked.has(props.sessionID)) await onRequestResolved({ type: 'permission', requestID: props.requestID, sessionID: props.sessionID, outcome: props.reply });
          return;
        case 'question.replied':
        case 'question.rejected':
          if (tracked.has(props.sessionID)) await onRequestResolved({ type: 'question', requestID: props.requestID, sessionID: props.sessionID, outcome: event.type === 'question.replied' ? 'replied' : 'rejected' });
          return;
        default:
      }
    });

  const resync = async () => {
    if (settled) return;
    const statuses = await api.sessionStatus();
    const own = statuses?.[sessionID];
    if (own?.type === 'busy') sawBusy = true;
    if (own?.type === 'retry') await handleRetryStatus(own);
    for (const child of (await api.children(sessionID)) ?? []) await addChild(child?.id);
    for (const req of (await api.listPermissions()) ?? []) await handlePermission(req);
    for (const req of (await api.listQuestions()) ?? []) await handleQuestion(req);
    if (!own || own.type === 'idle') await checkFinished();
  };

  const handleRetryStatus = async (status) => {
    lastPhase = 'retrying';
    progress({ phase: 'retrying', message: `Nova tentativa (${displayValue(status.attempt)}): ${displayValue(status.message ?? '')}`.trim() });
    if (!forcedError && retryExceedsCap(status, request.fallbackCfg ?? {})) {
      forcedError = { name: 'RetryCapExceeded', data: { message: 'Limite de tentativas do provedor excedido' } };
      progress({ message: 'Interrompendo sessão: limite de tentativas excedido' });
      await api.abort(sessionID);
      finish('forced-error');
    }
  };

  const untrack = hub.track(sessionID, onEvent);
  const offReconnect = hub.onReconnect(() => enqueue(resync));
  const timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);
  let pollTimer = null;
  const onAbort = () => finish('cancelled');
  if (signal?.aborted) finish('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      if (!signal?.aborted) await sendPrompt(api, sessionID, buildBody(request, messageID));
    } catch (err) {
      if (isServerDown(err)) finish('server-lost');
      else if (err instanceof OpcError && err.code === 'BAD_REQUEST') finish('prompt-failed', { error: { name: 'BadRequest', data: { message: 'A requisição do turno foi rejeitada' } } });
      else throw err;
    }
    pollTimer = setInterval(() => enqueue(resync), statusPollMs);
    const outcome = await done;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    return await buildResult(outcome);
  } finally {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', onAbort);
    untrack();
    offReconnect();
  }

  async function buildResult(outcome) {
    const base = { sessionID, messageID, childSessionIDs: [...children] };
    const serverLost = () => ({ ...serverLostResult(sessionID, messageID), ...base, toolsRan: toolsRanLive });
    if (outcome.reason === 'server-lost') return serverLost();
    if (outcome.reason === 'timeout' || outcome.reason === 'cancelled') {
      try {
        await api.abort(sessionID);
      } catch (err) {
        if (isServerDown(err)) return serverLost();
      }
      await waitIdle(api, sessionID, idleWaitMs);
    }
    let collected;
    try {
      const messages = await api.messages(sessionID, { limit: 200 });
      const childMessages = [];
      for (const child of children) childMessages.push(...((await api.messages(child, { limit: 200 })) ?? []));
      let diffs = [];
      try {
        diffs = (await api.diff(sessionID)) ?? [];
      } catch (err) {
        if (isServerDown(err)) throw err;
      }
      collected = extractTurn(turnMessages(messages, messageID), { childMessages, diffs });
    } catch (err) {
      if (isServerDown(err)) return serverLost();
      throw err;
    }
    const toolsRan = collected.toolsRan || toolsRanLive;
    const result = { ...base, ...collected, toolsRan };
    if (outcome.reason === 'no-assistant-message') {
      return { ...result, status: 'failed', errorClass: 'fatal', errorType: 'NoAssistantMessage', errorCode: 'NO_ASSISTANT_MESSAGE', errorMessage: 'A sessão ficou idle sem uma mensagem assistant concluída para este turno.' };
    }
    if (outcome.reason === 'callback-failed') {
      return { ...result, status: 'failed', errorClass: 'fatal', errorType: 'CallbackFailed', errorCode: 'CALLBACK_FAILED', errorMessage: `O callback do turno falhou: ${displayValue(outcome.detail?.message)}` };
    }
    if (outcome.reason === 'child-permission-failed') {
      return { ...result, status: 'failed', errorClass: 'fatal', errorType: 'ChildPermissionFailed', errorCode: 'CHILD_PERMISSION_FAILED', errorMessage: `Não foi possível aplicar as regras de permissão à sessão filha: ${displayValue(outcome.detail?.message)}` };
    }
    if (outcome.reason === 'forced-error' && forcedError) {
      const classified = classifyError(forcedError, { toolsRan });
      return { ...result, status: 'failed', error: forcedError, errorClass: classified.errorClass, errorType: classified.errorType, errorMessage: classified.message, errorCode: ERROR_CODES[classified.errorType] ?? 'model_error' };
    }
    if (outcome.reason === 'cancelled') {
      return { ...result, status: 'cancelled', errorClass: 'fatal', errorType: 'Cancelled', errorCode: 'cancelled', errorMessage: 'Turno cancelado' };
    }
    let error = collected.error;
    if (outcome.reason === 'timeout') error = { name: 'Timeout', data: { message: `O turno excedeu ${timeoutMs} ms e foi interrompido` } };
    else if (outcome.reason === 'session-error' || outcome.reason === 'prompt-failed') error = outcome.error;
    else if (forcedError) error = forcedError;
    if (!error) return { ...result, status: 'completed', error: null };
    const classified = classifyError(error, { toolsRan });
    return {
      ...result,
      status: 'failed',
      error,
      errorClass: classified.errorClass,
      errorType: classified.errorType,
      errorMessage: classified.message,
      errorCode: ERROR_CODES[classified.errorType] ?? 'model_error',
    };
  }
}
