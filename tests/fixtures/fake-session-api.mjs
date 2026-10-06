// In-memory OpenCode V2 session API for the HTTP fake and scenario tests.
import { randomBytes } from 'node:crypto';
import { redactText } from '../../plugins/opc/scripts/lib/redact.mjs';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}${Array.from(randomBytes(14), (b) => BASE62[b % 62]).join('')}`;
const ok = (data) => ({ body: { data } });
const empty = () => ({ status: 204 });
const bad = (message) => ({ status: 400, body: { _tag: 'InvalidRequestError', message } });
const missing = () => ({ status: 404, body: { _tag: 'NotFoundError', message: 'Recurso não encontrado' } });
const TOKENS = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
const MODEL = { id: 'opencode-go/deepseek-v4.1-flash', providerID: 'omniroute-personal' };
const validRules = (rules) => Array.isArray(rules) && rules.every((r) => r && typeof r.action === 'string' && typeof r.resource === 'string' && ['allow', 'deny', 'ask'].includes(r.effect));
const message = (type, extra = {}) => ({ id: id('msg'), type, time: { created: Date.now() }, ...extra });

export function installSessionApi(fake) {
  const state = fake.state;
  for (const key of ['sessions', 'messages', 'permissions', 'forms', 'statuses', 'diffs']) state[key] ??= {};
  for (const key of ['permissionReplies', 'formReplies', 'formCancels', 'aborts']) state[key] ??= [];
  const waiters = new Map();
  const turns = new Map();
  const persist = () => fake.persist?.();
  const event = (type, data) => { if (!fake.scenario?.dropSseEvents) fake.emit({ type, data }); };
  const settle = (requestID, answer) => { waiters.get(requestID)?.(answer); waiters.delete(requestID); };
  const getTurn = (sessionID) => {
    if (!turns.has(sessionID)) turns.set(sessionID, { aborted: false, timers: new Map() });
    return turns.get(sessionID);
  };
  fake.event = event;
  fake.setStatus = (sessionID, status) => {
    if (status.type === 'busy' && turns.get(sessionID)?.aborted) turns.delete(sessionID);
    if (status.type === 'busy') { getTurn(sessionID); state.statuses[sessionID] = { type: 'running' }; }
    else delete state.statuses[sessionID];
    persist();
  };
  fake.isAborted = (sessionID) => Boolean(turns.get(sessionID)?.aborted);
  fake.waitFor = (sessionID, ms) => {
    const turn = getTurn(sessionID);
    if (turn.aborted) return Promise.resolve({ aborted: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { turn.timers.delete(timer); resolve({ aborted: false }); }, ms);
      turn.timers.set(timer, resolve);
    });
  };
  fake.createSession = (body = {}, directory = '') => {
    const now = Date.now();
    const session = { id: id('ses'), projectID: 'global', agent: body.agent ?? 'build', model: body.model ?? MODEL,
      permissions: structuredClone(body.permissions ?? []), time: { created: now, updated: now },
      title: body.title ?? 'Nova sessão', location: { directory }, cost: 0, tokens: structuredClone(TOKENS),
      ...(body.parentID ? { parentID: body.parentID } : {}) };
    state.sessions[session.id] = session;
    state.messages[session.id] = [];
    persist();
    event('session.created', { sessionID: session.id, ...(session.parentID ? { parentID: session.parentID } : {}) });
    return session;
  };
  fake.createChildSession = (parentID, { title = 'OPC: subagente', agent = 'general' } = {}) => {
    const parent = state.sessions[parentID];
    if (!parent) throw new Error('Sessão pai não encontrada');
    return fake.createSession({ parentID, title, agent, model: structuredClone(parent.model), permissions: structuredClone(parent.permissions) }, parent.location.directory);
  };
  fake.askPermission = (sessionID, { action, resources, save = [] }) => {
    const request = { id: id('per'), sessionID, action, resources, save,
      source: { type: 'tool', messageID: id('msg'), id: id('call') } };
    state.permissions[request.id] = request;
    persist();
    event('permission.asked', request);
    return new Promise((resolve) => waiters.set(request.id, resolve));
  };
  fake.askQuestion = (sessionID, fields) => {
    const form = { id: id('frm'), sessionID, title: 'Perguntas', metadata: { kind: 'question' }, fields };
    state.forms[form.id] = form;
    persist();
    event('form.created', { form });
    return new Promise((resolve) => waiters.set(form.id, resolve));
  };
  fake.failExecution = (sessionID, error) => {
    if (fake.isAborted(sessionID)) return;
    state.messages[sessionID] ??= [];
    state.messages[sessionID].push(message('idle', { outcome: 'failed' }));
    fake.setStatus(sessionID, { type: 'idle' });
    event('session.execution.failed', { sessionID, error });
  };
  fake.emitTurn = async (sessionID, { text = 'ok', tools = [], delayMs = 20, error, tokens = TOKENS, cost = 0 } = {}) => {
    const session = state.sessions[sessionID];
    if (!session) throw new Error('Sessão não encontrada');
    if (fake.isAborted(sessionID)) return;
    fake.setStatus(sessionID, { type: 'busy' });
    const turn = getTurn(sessionID);
    const wait = async () => (await fake.waitFor(sessionID, delayMs)).aborted || turn.aborted;
    event('session.execution.started', { sessionID });
    if (error && tools.length === 0) { fake.failExecution(sessionID, error); return; }
    const assistant = message('assistant', { agent: session.agent, model: session.model, content: [], cost, tokens,
      finish: tools.length ? 'tool-calls' : 'stop' });
    event('session.step.started', { sessionID, assistantMessageID: assistant.id, agent: session.agent, model: session.model });
    for (const tool of tools) {
      if (await wait()) return;
      const callID = id('call');
      const content = [{ type: 'text', text: String(tool.output ?? '') }];
      const part = { type: 'tool', id: callID, name: tool.tool,
        state: { status: 'running', input: tool.input ?? {}, content: [], metadata: tool.metadata ?? {} } };
      assistant.content.push(part);
      event('session.tool.called', { sessionID, assistantMessageID: assistant.id, id: callID, name: tool.tool, input: part.state.input });
      if (await wait()) return;
      part.state = tool.error ? { ...part.state, status: 'error', error: tool.error } : { ...part.state, status: 'completed', content };
      event(tool.error ? 'session.tool.failed' : 'session.tool.success', { sessionID, assistantMessageID: assistant.id, id: callID,
        ...(tool.error ? { error: tool.error } : { content }) });
    }
    if (error) {
      assistant.time.completed = Date.now();
      state.messages[sessionID].push(assistant);
      event('session.step.ended', { sessionID, assistantMessageID: assistant.id, finish: 'error', cost, tokens });
      event('session.usage.updated', { sessionID, cost, tokens });
      fake.failExecution(sessionID, error);
      return;
    }
    if (await wait()) return;
    if (text) {
      assistant.content.push({ type: 'text', text });
      event('session.text.delta', { sessionID, assistantMessageID: assistant.id, text });
      event('session.text.ended', { sessionID, assistantMessageID: assistant.id, text });
    }
    assistant.time.completed = Date.now();
    state.messages[sessionID].push(assistant, message('idle', { outcome: 'succeeded' }));
    event('session.step.ended', { sessionID, assistantMessageID: assistant.id, finish: assistant.finish, cost, tokens });
    event('session.usage.updated', { sessionID, cost, tokens });
    turns.delete(sessionID);
    fake.setStatus(sessionID, { type: 'idle' });
    event('session.execution.succeeded', { sessionID });
  };
  fake.abortSession = (sessionID) => {
    const running = Boolean(state.statuses[sessionID]);
    state.aborts.push(sessionID);
    const turn = turns.get(sessionID);
    if (turn) {
      turn.aborted = true;
      for (const [timer, resolve] of turn.timers) { clearTimeout(timer); resolve({ aborted: true }); }
      turn.timers.clear();
    }
    for (const collection of [state.permissions, state.forms]) {
      for (const [requestID, request] of Object.entries(collection)) {
        if (request.sessionID !== sessionID) continue;
        delete collection[requestID];
        settle(requestID, { aborted: true });
      }
    }
    if (running) {
      state.messages[sessionID].push(message('idle', { outcome: 'interrupted' }));
      fake.setStatus(sessionID, { type: 'idle' });
      event('session.execution.interrupted', { sessionID, reason: 'user' });
    }
    persist();
    return running;
  };

  const routes = [
    ['POST', /^\/api\/session$/, (_m, _q, body, directory) =>
      body && validRules(body.permissions) && body.model?.id && body.model?.providerID
        ? ok(fake.createSession(body, directory ?? '')) : bad('Modelo e permissões inválidos')],
    ['GET', /^\/api\/session$/, (_m, q) => ok(Object.values(state.sessions).filter((s) => !q.get('parentID') || s.parentID === q.get('parentID')).sort((a, b) => b.time.updated - a.time.updated))],
    ['GET', /^\/api\/session\/active$/, () => ok({ ...state.statuses })],
    ['GET', /^\/api\/session\/(ses[^/]+)$/, (m) => state.sessions[m[1]] ? ok(state.sessions[m[1]]) : missing()],
    ['PATCH', /^\/api\/session\/(ses[^/]+)$/, (m, _q, body) => {
      const session = state.sessions[m[1]];
      if (!session) return missing();
      if (!validRules(body?.permissions)) return bad('Permissões inválidas');
      session.permissions = structuredClone(body.permissions);
      session.time.updated = Date.now();
      persist();
      return empty();
    }],
    ['POST', /^\/api\/session\/(ses[^/]+)\/(model|agent)$/, (m, _q, body) => {
      const session = state.sessions[m[1]];
      if (!session) return missing();
      if (m[2] === 'model') {
        if (!body?.model?.id || !body?.model?.providerID) return bad('Modelo inválido');
        session.model = body.model;
        state.messages[m[1]].push(message('model-switched', { model: body.model }));
      } else {
        if (!body?.agent) return bad('Agente inválido');
        session.agent = body.agent;
      }
      persist();
      return empty();
    }],
    ['POST', /^\/api\/session\/(ses[^/]+)\/prompt$/, (m, _q, body) => {
      const session = state.sessions[m[1]];
      if (!session) return missing();
      if (typeof body?.text !== 'string') return bad('Texto obrigatório');
      if (Object.keys(body).some((key) => !['id', 'text', 'files', 'agents', 'skills', 'delivery', 'resume'].includes(key))) return bad('Campos do prompt inválidos');
      if (body.id !== undefined && !/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(body.id)) return bad('ID da mensagem inválido');
      const existing = body.id && state.messages[session.id].find((item) => item.id === body.id);
      if (existing) return ok(existing);
      const user = message('user', { id: body.id ?? id('msg'), text: body.text });
      state.messages[session.id].push(user);
      fake.setStatus(session.id, { type: 'busy' });
      persist();
      setImmediate(() => {
        if (fake.isAborted(session.id)) return;
        const hook = fake.scenario?.onPrompt;
        Promise.resolve(hook ? hook(fake, session.id, body) : fake.emitTurn(session.id)).catch((err) => {
          const preview = redactText(String(err?.message ?? err)).replace(/[\r\n]+/g, ' ').slice(0, 12);
          process.stderr.write(`Erro no cenário do servidor falso: ${preview}…\n`);
        });
      });
      return ok(user);
    }],
    ['POST', /^\/api\/session\/(ses[^/]+)\/interrupt$/, (m) => ({ body: { interrupted: fake.abortSession(m[1]) } })],
    ['GET', /^\/api\/session\/(ses[^/]+)\/message$/, (m, q) => {
      if (!state.messages[m[1]]) return missing();
      const ordered = q.get('order') === 'asc' ? [...state.messages[m[1]]] : [...state.messages[m[1]]].reverse();
      const limit = Number(q.get('limit'));
      return ok(limit > 0 ? ordered.slice(0, limit) : ordered);
    }],
    ['GET', /^\/api\/session\/(ses[^/]+)\/permission$/, (m) => ok(Object.values(state.permissions).filter((r) => r.sessionID === m[1]))],
    ['POST', /^\/api\/session\/(ses[^/]+)\/permission\/(per[^/]+)\/reply$/, (m, _q, body) => {
      const request = state.permissions[m[2]];
      if (!request || request.sessionID !== m[1]) return missing();
      if (!['once', 'always', 'reject'].includes(body?.decision)) return bad('Decisão inválida');
      delete state.permissions[m[2]];
      state.permissionReplies.push({ requestID: m[2], decision: body.decision });
      event('permission.replied', { sessionID: m[1], requestID: m[2], reply: body.decision });
      if (body.decision === 'reject') event('session.tool.failed', { sessionID: m[1], id: request.source.id, error: { type: 'permission.rejected', message: 'Permissão recusada' } });
      settle(m[2], body.decision);
      persist();
      return empty();
    }],
    ['GET', /^\/api\/session\/(ses[^/]+)\/form$/, (m) => ok(Object.values(state.forms).filter((r) => r.sessionID === m[1]))],
    ['POST', /^\/api\/session\/(ses[^/]+)\/form\/(frm[^/]+)\/reply$/, (m, _q, body) => {
      const form = state.forms[m[2]];
      if (!form || form.sessionID !== m[1]) return missing();
      if (!body?.answer || typeof body.answer !== 'object' || Array.isArray(body.answer)) return bad('Resposta inválida');
      delete state.forms[m[2]];
      state.formReplies.push({ id: m[2], answer: body.answer });
      event('form.replied', { id: m[2], sessionID: m[1], answer: body.answer });
      settle(m[2], body.answer);
      persist();
      return empty();
    }],
    ['DELETE', /^\/api\/session\/(ses[^/]+)\/form\/(frm[^/]+)$/, (m) => {
      const form = state.forms[m[2]];
      if (!form || form.sessionID !== m[1]) return missing();
      delete state.forms[m[2]];
      state.formCancels.push(m[2]);
      event('form.cancelled', { id: m[2], sessionID: m[1] });
      settle(m[2], { cancelled: true });
      persist();
      return empty();
    }],
  ];
  return { handle(method, pathname, query, body, directory) {
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = pattern.exec(pathname);
      if (match) return handler(match, query, body, directory);
    }
    return null;
  } };
}

export const SESSION_API_ROUTES = Object.freeze([
  'POST /api/session', 'GET /api/session', 'GET /api/session/active', 'GET /api/session/:id', 'PATCH /api/session/:id',
  'POST /api/session/:id/model', 'POST /api/session/:id/agent', 'POST /api/session/:id/prompt',
  'POST /api/session/:id/interrupt', 'GET /api/session/:id/message', 'GET /api/session/:id/permission',
  'POST /api/session/:id/permission/:requestID/reply', 'GET /api/session/:id/form',
  'POST /api/session/:id/form/:formID/reply', 'DELETE /api/session/:id/form/:formID',
]);
