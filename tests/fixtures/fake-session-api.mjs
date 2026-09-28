// Session, prompt, permission and question routes of the fake OpenCode server (F2a).
// Shapes follow the OpenAPI of OpenCode 1.18.32; PATCH /session/:id appends permission rules,
// like the 1.18.32 binary (`merge(old, new)` = concatenation).
import { randomBytes } from 'node:crypto';

const SESSION_KEYS = new Set(['parentID', 'title', 'agent', 'model', 'metadata', 'permission', 'workspaceID']);
const PATCH_KEYS = new Set(['title', 'metadata', 'permission', 'time']);
const PROMPT_KEYS = new Set(['messageID', 'model', 'agent', 'noReply', 'tools', 'format', 'system', 'variant', 'parts']);
const REPLIES = new Set(['once', 'always', 'reject']);
const ACTIONS = new Set(['allow', 'deny', 'ask']);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const nextId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}${Array.from(randomBytes(14), (b) => BASE62[b % 62]).join('')}`;
const invalid = (message) => ({ status: 400, body: { _tag: 'InvalidRequestError', message } });
const notFound = (tag, message) => ({ status: 404, body: { _tag: tag, message } });
const ok = (body) => ({ status: 200, body });
const extraKeys = (body, allowed) => Object.keys(body ?? {}).filter((key) => !allowed.has(key));
const validRules = (rules) => Array.isArray(rules) && rules.every((r) => r && typeof r.permission === 'string' && typeof r.pattern === 'string' && ACTIONS.has(r.action) && Object.keys(r).length === 3);

export function installSessionApi(fake) {
  const state = fake.state;
  for (const key of ['sessions', 'messages', 'permissions', 'questions', 'statuses', 'diffs']) state[key] ??= {};
  for (const key of ['permissionReplies', 'questionReplies', 'questionRejects', 'aborts']) state[key] ??= [];
  const waiters = new Map();
  const turns = new Map();
  const persist = () => fake.persist();
  const event = (type, properties) => fake.emit({ id: nextId('evt'), type, properties });

  const settle = (requestID, outcome) => {
    const resolve = waiters.get(requestID);
    waiters.delete(requestID);
    resolve?.(outcome);
  };

  fake.event = event;

  fake.setStatus = (sessionID, status) => {
    if (status.type === 'idle') delete state.statuses[sessionID];
    else state.statuses[sessionID] = status;
    persist();
    event('session.status', { sessionID, status });
  };

  fake.createSession = (body = {}, directory = '') => {
    const time = Date.now();
    const session = {
      id: nextId('ses'), slug: `fake-${randomBytes(3).toString('hex')}`, projectID: 'prj_fake', directory,
      title: body.title ?? 'New session', version: '1.18.32', time: { created: time, updated: time },
      permission: body.permission ?? [],
      ...(body.parentID ? { parentID: body.parentID } : {}),
      ...(body.agent ? { agent: body.agent } : {}),
    };
    state.sessions[session.id] = session;
    state.messages[session.id] = [];
    persist();
    event('session.created', { sessionID: session.id, info: session });
    return session;
  };

  fake.createChildSession = (parentID, { title = 'child (@general subagent)', agent = 'general' } = {}) =>
    fake.createSession({ parentID, title, agent }, state.sessions[parentID]?.directory ?? '');

  fake.askPermission = (sessionID, { permission, patterns, metadata = {}, always = [] }) => {
    const request = { id: nextId('per'), sessionID, permission, patterns, metadata, always };
    state.permissions[request.id] = request;
    persist();
    event('permission.asked', request);
    return new Promise((resolve) => waiters.set(request.id, resolve));
  };

  fake.askQuestion = (sessionID, questions) => {
    const request = { id: nextId('que'), sessionID, questions };
    state.questions[request.id] = request;
    persist();
    event('question.asked', request);
    return new Promise((resolve) => waiters.set(request.id, resolve));
  };

  fake.emitTurn = async (sessionID, {
    text = 'fake-opencode: ok', structured, tools = [], error, delayMs = 20, parentID,
    tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost = 0,
  } = {}) => {
    const session = state.sessions[sessionID];
    const turn = { aborted: false, timers: new Set() };
    turns.set(sessionID, turn);
    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => { turn.timers.delete(timer); resolve(); }, ms);
      turn.timers.add(timer);
    });
    const info = {
      id: nextId('msg'), sessionID, role: 'assistant', parentID: parentID ?? session.lastUserMessageID,
      time: { created: Date.now() }, modelID: session.lastModel?.modelID ?? 'fake-model',
      providerID: session.lastModel?.providerID ?? 'fake', mode: 'build', agent: 'build',
      path: { cwd: session.directory, root: session.directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const message = { info, parts: [] };
    fake.setStatus(sessionID, { type: 'busy' });
    state.messages[sessionID].push(message);
    persist();
    event('message.updated', { sessionID, info });
    for (const tool of tools) {
      await wait(delayMs);
      if (turn.aborted) return;
      const start = Date.now();
      const part = { id: nextId('prt'), sessionID, messageID: info.id, type: 'tool', callID: nextId('call'), tool: tool.tool, state: { status: 'running', input: tool.input ?? {}, time: { start } } };
      message.parts.push(part);
      event('message.part.updated', { sessionID, part, time: Date.now() });
      await wait(delayMs);
      if (turn.aborted) return;
      part.state = { status: 'completed', input: tool.input ?? {}, output: tool.output ?? '', title: tool.tool, metadata: tool.metadata ?? {}, time: { start, end: Date.now() } };
      persist();
      event('message.part.updated', { sessionID, part, time: Date.now() });
    }
    await wait(delayMs);
    if (turn.aborted) return;
    if (text) {
      const part = { id: nextId('prt'), sessionID, messageID: info.id, type: 'text', text, time: { start: Date.now(), end: Date.now() } };
      message.parts.push(part);
      event('message.part.updated', { sessionID, part, time: Date.now() });
    }
    await wait(delayMs);
    if (turn.aborted) return;
    info.time.completed = Date.now();
    info.finish = structured === undefined ? 'stop' : 'tool-calls';
    info.tokens = tokens;
    info.cost = cost;
    if (structured !== undefined) info.structured = structured;
    if (error) info.error = error;
    persist();
    event('message.updated', { sessionID, info });
    if (error) event('session.error', { sessionID, error });
    turns.delete(sessionID);
    fake.setStatus(sessionID, { type: 'idle' });
    event('session.idle', { sessionID });
  };

  fake.abortSession = (sessionID) => {
    state.aborts.push(sessionID);
    const turn = turns.get(sessionID);
    if (turn) {
      turn.aborted = true;
      for (const timer of turn.timers) clearTimeout(timer);
      turns.delete(sessionID);
    }
    for (const [id, request] of [...Object.entries(state.permissions), ...Object.entries(state.questions)]) {
      if (request.sessionID !== sessionID) continue;
      delete state.permissions[id];
      delete state.questions[id];
      settle(id, { reply: 'reject', aborted: true });
    }
    if (state.statuses[sessionID]) {
      const messages = state.messages[sessionID] ?? [];
      let last = messages.at(-1);
      if (!last || last.info.role !== 'assistant' || last.info.time.completed) {
        last = { info: { id: nextId('msg'), sessionID, role: 'assistant', parentID: state.sessions[sessionID]?.lastUserMessageID, time: { created: Date.now() }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] };
        messages.push(last);
      }
      last.info.error = { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } };
      last.info.time.completed = Date.now();
      event('message.updated', { sessionID, info: last.info });
      fake.setStatus(sessionID, { type: 'idle' });
      event('session.idle', { sessionID });
    }
    persist();
  };

  const routes = [
    ['POST', /^\/session$/, (m, query, body) => {
      const extra = extraKeys(body, SESSION_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (body?.permission !== undefined && !validRules(body.permission)) return invalid('permission must be an array of {permission, pattern, action}');
      if (body?.parentID !== undefined && !/^ses/.test(body.parentID)) return invalid('parentID must start with ses');
      return ok(fake.createSession(body ?? {}, query.get('directory') ?? ''));
    }],
    ['GET', /^\/session$/, () => ok(Object.values(state.sessions))],
    ['GET', /^\/session\/status$/, () => ok({ ...state.statuses })],
    ['GET', /^\/session\/(ses[^/]+)$/, (m) => (state.sessions[m[1]] ? ok(state.sessions[m[1]]) : notFound('NotFoundError', `session ${m[1]} not found`))],
    ['PATCH', /^\/session\/(ses[^/]+)$/, (m, query, body) => {
      const session = state.sessions[m[1]];
      if (!session) return notFound('NotFoundError', `session ${m[1]} not found`);
      const extra = extraKeys(body, PATCH_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (body?.permission !== undefined) {
        if (!validRules(body.permission)) return invalid('permission must be an array of {permission, pattern, action}');
        session.permission = [...(session.permission ?? []), ...body.permission];
      }
      if (typeof body?.title === 'string') session.title = body.title;
      session.time.updated = Date.now();
      persist();
      event('session.updated', { sessionID: session.id, info: session });
      return ok(session);
    }],
    ['POST', /^\/session\/(ses[^/]+)\/prompt_async$/, (m, query, body) => {
      const session = state.sessions[m[1]];
      if (!session) return notFound('NotFoundError', `session ${m[1]} not found`);
      const extra = extraKeys(body, PROMPT_KEYS);
      if (extra.length) return invalid(`unexpected keys: ${extra.join(', ')}`);
      if (!Array.isArray(body?.parts)) return invalid('parts is required');
      if (body.messageID !== undefined && !/^msg/.test(body.messageID)) return invalid('messageID must start with msg');
      if (body.model !== undefined && (typeof body.model.providerID !== 'string' || typeof body.model.modelID !== 'string' || Object.keys(body.model).length !== 2)) return invalid('model must be {providerID, modelID}');
      const id = body.messageID ?? nextId('msg');
      state.messages[session.id].push({
        info: { id, sessionID: session.id, role: 'user', time: { created: Date.now() }, agent: body.agent ?? 'build', ...(body.model ? { model: body.model } : {}), ...(body.format ? { format: body.format } : {}) },
        parts: body.parts.map((part) => ({ id: nextId('prt'), sessionID: session.id, messageID: id, ...part })),
      });
      session.lastUserMessageID = id;
      session.lastModel = body.model ?? null;
      persist();
      setImmediate(() => {
        const hook = fake.scenario?.onPromptAsync;
        Promise.resolve(hook ? hook(fake, session.id, body) : fake.emitTurn(session.id)).catch((err) => {
          process.stderr.write(`fake-opencode scenario error: ${err.stack}\n`);
        });
      });
      return { status: 204, body: null };
    }],
    ['POST', /^\/session\/(ses[^/]+)\/abort$/, (m) => {
      fake.abortSession(m[1]);
      return ok(true);
    }],
    ['GET', /^\/session\/(ses[^/]+)\/message$/, (m, query) => {
      const messages = state.messages[m[1]];
      if (!messages) return notFound('NotFoundError', `session ${m[1]} not found`);
      const limit = Number(query.get('limit'));
      return ok(Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages);
    }],
    ['GET', /^\/session\/(ses[^/]+)\/children$/, (m) => ok(Object.values(state.sessions).filter((s) => s.parentID === m[1]))],
    ['GET', /^\/session\/(ses[^/]+)\/diff$/, (m) => ok(state.diffs[m[1]] ?? [])],
    ['GET', /^\/permission$/, () => ok(Object.values(state.permissions))],
    ['POST', /^\/permission\/(per[^/]+)\/reply$/, (m, query, body) => {
      const extra = extraKeys(body, new Set(['reply', 'message']));
      if (extra.length || !REPLIES.has(body?.reply)) return invalid('body must be {reply: once|always|reject, message?}');
      const request = state.permissions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'PermissionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.permissions[m[1]];
      state.permissionReplies.push({ requestID: m[1], reply: body.reply, message: body.message ?? null });
      event('permission.replied', { sessionID: request.sessionID, requestID: m[1], reply: body.reply });
      settle(m[1], { reply: body.reply, message: body.message });
      if (body.reply === 'reject') {
        for (const sibling of Object.values(state.permissions)) {
          if (sibling.sessionID !== request.sessionID) continue;
          delete state.permissions[sibling.id];
          state.permissionReplies.push({ requestID: sibling.id, reply: 'reject', message: null, sibling: true });
          event('permission.replied', { sessionID: sibling.sessionID, requestID: sibling.id, reply: 'reject' });
          settle(sibling.id, { reply: 'reject' });
        }
      }
      persist();
      return ok(true);
    }],
    ['GET', /^\/question$/, () => ok(Object.values(state.questions))],
    ['POST', /^\/question\/(que[^/]+)\/reply$/, (m, query, body) => {
      const answers = body?.answers;
      if (extraKeys(body, new Set(['answers'])).length || !Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) {
        return invalid('body must be {answers: string[][]}');
      }
      const request = state.questions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'QuestionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.questions[m[1]];
      state.questionReplies.push({ requestID: m[1], answers });
      persist();
      event('question.replied', { sessionID: request.sessionID, requestID: m[1], answers });
      settle(m[1], { answers });
      return ok(true);
    }],
    ['POST', /^\/question\/(que[^/]+)\/reject$/, (m) => {
      const request = state.questions[m[1]];
      if (!request) return { status: 404, body: { _tag: 'QuestionNotFoundError', requestID: m[1], message: 'not found' } };
      delete state.questions[m[1]];
      state.questionRejects.push({ requestID: m[1] });
      persist();
      event('question.rejected', { sessionID: request.sessionID, requestID: m[1] });
      settle(m[1], { rejected: true });
      return ok(true);
    }],
  ];

  return {
    handle(method, pathname, query, body) {
      for (const [routeMethod, pattern, handler] of routes) {
        if (routeMethod !== method) continue;
        const match = pattern.exec(pathname);
        if (match) return handler(match, query, body);
      }
      return null;
    },
  };
}

// Route keys served by installSessionApi; registered over the F0 DEFAULT_ROUTES stubs by the F2a extension
// at the end of tests/fixtures/fake-opencode.mjs.
export const SESSION_API_ROUTES = Object.freeze([
  'POST /session', 'GET /session', 'GET /session/status', 'GET /session/:id', 'PATCH /session/:id',
  'POST /session/:id/prompt_async', 'POST /session/:id/abort', 'GET /session/:id/message',
  'GET /session/:id/children', 'GET /session/:id/diff',
  'GET /permission', 'POST /permission/:id/reply',
  'GET /question', 'POST /question/:id/reply', 'POST /question/:id/reject',
]);
