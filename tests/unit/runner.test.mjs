import test from 'node:test';
import assert from 'node:assert/strict';
import { newMessageId, phaseFromPart, runTurn, turnMessages, extractTurn, toolErrorSummary } from '../../plugins/opc/scripts/lib/runner.mjs';
import { ConnectionError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

function memoryV2({ promptFailsOnce } = {}) {
  const handlers = new Map();
  const anyHandlers = new Set();
  let resolveCreated, resolvePrompt;
  let active = true;
  const messages = new Map();
  const sessions = new Map();
  const api = {
    calls: [], promptCalls: [], messageReadsBeforeEnd: 0,
    created: new Promise((resolve) => { resolveCreated = resolve; }),
    promptSettled: new Promise((resolve) => { resolvePrompt = resolve; }),
    async createSession(body) { this.createdBody = body; sessions.set('ses_mem1', body); resolveCreated('ses_mem1'); return { id: 'ses_mem1' }; },
    async getSession(id) { const body = sessions.get(id) ?? this.createdBody; return { id, model: body.model, agent: body.agent, permissions: body.permissions }; },
    async setPermissions(id, rules) { this.calls.push(['setPermissions', id, rules]); },
    async setModel(id, model) { this.calls.push(['setModel', id, model]); },
    async setAgent(id, agent) { this.calls.push(['setAgent', id, agent]); },
    async prompt(id, body) {
      this.promptCalls.push(body);
      if (promptFailsOnce && this.promptCalls.length === 1) throw new RequestError(promptFailsOnce, 'timeout');
      resolvePrompt();
    },
    lastPromptId() { return this.promptCalls.at(-1)?.id; },
    messagesFor(id, list) { messages.set(id, list); },
    async messages(id) { if (active) this.messageReadsBeforeEnd++; return messages.get(id) ?? []; },
    async sessionStatus() { return active ? { ses_mem1: { type: 'busy' } } : {}; },
    async children() { return []; },
    async listPermissions() { return []; },
    async listQuestions() { return []; },
    async interrupt() { return true; },
    async diff() { return []; },
  };
  const hub = {
    track(id, handler) { handlers.set(id, handler); return () => handlers.delete(id); },
    onReconnect() { return () => {}; },
    onAny(handler) { anyHandlers.add(handler); return () => anyHandlers.delete(handler); },
  };
  const emit = (event) => {
    for (const handler of anyHandlers) handler(event);
    if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) active = false;
    if (event.type === 'session.created' && event.data?.parentID && handlers.has(event.data.parentID)) {
      handlers.set(event.data.sessionID, handlers.get(event.data.parentID));
      const parent = sessions.get(event.data.parentID) ?? api.createdBody;
      sessions.set(event.data.sessionID, { model: parent.model, agent: parent.agent, permissions: structuredClone(parent.permissions) });
    }
    handlers.get(event.data?.sessionID)?.(event);
  };
  return { api, hub, emit };
}

test('V2 turn completes on execution.succeeded and reads idle-bounded messages', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  const sample = loadContractSample('messages-turn.json').data;
  api.messagesFor(sessionID, [{ ...sample[0], id: api.lastPromptId() }, ...sample.slice(1)]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'hello');
  assert.deepEqual(result.toolNames, ['read']);
  assert.equal(result.usage.input, 5573);
  assert.equal(api.createdBody.permissions.length, 1);
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
});

test('V2 task preserves a JSON object returned as text', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { kind: 'task', model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'give me json' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user' }, { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: '{"verdict":"approve"}' }] }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  assert.deepEqual((await pending).structured, { verdict: 'approve' });
});

test('V2 JSON schema request adds text instruction and accepts only matching output', async () => {
  const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };
  for (const [reply, expected] of [['{"files":["a"]}', { files: ['a'] }], ['{"files":"a"}', null]]) {
    const { api, hub, emit } = memoryV2();
    const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'List files' }], format: { type: 'json_schema', schema }, newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
    const sessionID = await api.created;
    await api.promptSettled;
    assert.deepEqual(Object.keys(api.promptCalls[0]).sort(), ['id', 'text']);
    assert.match(api.promptCalls[0].text, /List files\n\nReply with only one JSON object/);
    assert.match(api.promptCalls[0].text, /"required":\["files"\]/);
    api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user' }, { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: reply }] }, { type: 'idle', outcome: 'succeeded' }]);
    emit({ type: 'session.execution.succeeded', data: { sessionID } });
    const result = await pending;
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.structured, expected);
    assert.equal(result.structuredSource, expected ? 'text' : null);
  }
});

test('V2 runner retains a review finding without a file for conclave clustering', async () => {
  const finding = { severity: 'low', title: 'Missing tests', body: 'No test covers this behavior.', confidence: 0.5, recommendation: 'Add a test.' };
  const schema = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, file: { type: ['string', 'null'] } } } } } };
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'Review changes' }], format: { type: 'json_schema', schema }, newSession: { title: 'OPC: review', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  const response = { findings: [finding] };
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user' }, { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: JSON.stringify(response) }] }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  const result = await pending;
  assert.deepEqual(result.structured, response);
  assert.equal(result.structuredSource, 'text');
});

test('V2 execution.failed before assistant is a classified provider failure', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'missing' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'hi' }, { id: 'msg_i', type: 'idle', outcome: 'failed' }]);
  emit({ type: 'session.execution.failed', data: { sessionID, error: { type: 'provider.no-route', message: 'Model unavailable: p/missing' } } });
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.notEqual(result.errorCode, 'NO_ASSISTANT_MESSAGE');
  assert.match(result.errorMessage, /p\/missing/);
  assert.match(result.error.data.message, /p\/missing/);
});

test('V2 completed turn beyond 200 messages retains its text', async () => {
  const { api, hub, emit } = memoryV2();
  const original = api.messages;
  api.messages = async (id, { limit } = {}) => (await original(id)).slice(0, limit);
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] } });
  const id = await api.created;
  await api.promptSettled;
  api.messagesFor(id, [...Array.from({ length: 201 }, (_, i) => ({ id: `msg_old${i}`, type: 'user' })), { id: api.lastPromptId(), type: 'user' }, { id: 'msg_final', type: 'assistant', content: [{ type: 'text', text: 'long session result' }] }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: id } });
  assert.equal((await pending).finalText, 'long session result');
});

test('V2 missing prompt in a completed session fails explicitly', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] } });
  const id = await api.created;
  await api.promptSettled;
  api.messagesFor(id, [{ id: 'old', type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: id } });
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'TURN_MESSAGE_NOT_FOUND');
});

for (const method of ['sessionStatus', 'children', 'listPermissions', 'listQuestions', 'messages']) {
  test(`V2 resync reports ${method} API failure without waiting for timeout`, async () => {
    const { api, hub } = memoryV2();
    let reconnect;
    hub.onReconnect = (handler) => { reconnect = handler; return () => {}; };
    const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], timeoutMs: 1000 } });
    const id = await api.created;
    await api.promptSettled;
    api.sessionStatus = async () => ({});
    api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }]);
    api[method] = async () => { throw new RequestError('API_FAILED', `${method} failed`); };
    reconnect();
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'API_FAILED');
    assert.match(result.errorMessage, new RegExp(method));
  });
}

test('V2 resync failure interrupts an active session before returning failure', async () => {
  const { api, hub } = memoryV2();
  let reconnect;
  hub.onReconnect = (handler) => { reconnect = handler; return () => {}; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], idleWaitMs: 50, timeoutMs: 1000 } });
  const id = await api.created;
  await api.promptSettled;
  api.children = async () => { throw new RequestError('API_FAILED', 'children failed'); };
  api.interrupt = async (sessionID) => { api.calls.push(['interrupt', sessionID]); api.sessionStatus = async () => ({}); return true; };
  reconnect();
  const result = await pending;
  assert.equal(result.errorCode, 'API_FAILED');
  assert.deepEqual(api.calls.filter(([name]) => name === 'interrupt'), [['interrupt', id]]);
  assert.equal(result.abortConfirmed, true);
});

test('V2 resync failure reports an unconfirmed interrupt', async () => {
  const { api, hub } = memoryV2();
  let reconnect;
  hub.onReconnect = (handler) => { reconnect = handler; return () => {}; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], idleWaitMs: 5, timeoutMs: 1000 } });
  await api.created;
  await api.promptSettled;
  api.children = async () => { throw new RequestError('API_FAILED', 'children failed'); };
  api.interrupt = async () => false;
  reconnect();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.abortConfirmed, false);
  assert.deepEqual(result.sessionAborts.map(({ aborted }) => aborted), [false]);
});

test('V2 prompt timeout resends same id without reading messages', async () => {
  const { api, hub, emit } = memoryV2({ promptFailsOnce: 'TIMEOUT' });
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  const sessionID = await api.created;
  await api.promptSettled;
  assert.equal(api.promptCalls.length, 2);
  assert.equal(api.promptCalls[0].id, api.promptCalls[1].id);
  assert.equal(api.messageReadsBeforeEnd, 0);
  api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user', text: 'hi' }, { id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'ok' }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg_c', type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
  assert.equal((await pending).finalText, 'ok');
});

function stubHub() {
  const handlers = new Map();
  const reconnects = new Set();
  return {
    track(sessionID, handler) { handlers.set(sessionID, handler); return () => handlers.delete(sessionID); },
    onReconnect(handler) { reconnects.add(handler); return () => reconnects.delete(handler); },
    emit(event) { for (const h of handlers.values()) h(event); },
    reconnect() { for (const h of reconnects) h(); },
    get tracked() { return [...handlers.keys()]; },
  };
}

function stubApi({ hub, onPrompt = () => {}, statusMap = {}, extra = {} } = {}) {
  const calls = [];
  const store = {};
  const api = {
    calls, store, statusMap,
    permissions: [], questions: [], childrenOf: {}, diffs: {},
    async createSession(body) { calls.push(['createSession', body]); store.ses_new = []; return { id: 'ses_new', permission: body.permission ?? [] }; },
    async patchSession(id, body) { calls.push(['patchSession', id, body]); return { id, permission: [...(extra.existingPermission ?? []), ...body.permission] }; },
    async promptAsync(id, body) { calls.push(['promptAsync', id, body]); (store[id] ??= []).push({ info: { id: body.messageID, role: 'user', sessionID: id }, parts: body.parts }); setImmediate(() => onPrompt(id, body)); return null; },
    async abort(id) { calls.push(['abort', id]); statusMap[id] = undefined; return true; },
    async sessionStatus() { calls.push(['sessionStatus']); return Object.fromEntries(Object.entries(statusMap).filter(([, v]) => v)); },
    async messages(id) { calls.push(['messages', id]); return store[id] ?? []; },
    async children(id) { return (api.childrenOf[id] ?? []).map((cid) => ({ id: cid })); },
    async diff(id) { return api.diffs[id] ?? []; },
    async listPermissions() { return api.permissions; },
    async listQuestions() { return api.questions; },
    ...extra.methods,
  };
  return api;
}

const MODEL = { providerID: 'p', modelID: 'm/x' };
const baseRequest = (over = {}) => ({ newSession: { title: 'OPC: task: t', permission: [] }, parts: [{ type: 'text', text: 'hi' }], model: MODEL, timeoutMs: 5000, statusPollMs: 50, idleWaitMs: 200, fallbackCfg: { maxProviderRetries: 3, maxRetryWaitSec: 60 }, ...over });

function assistant(sessionID, parentID, { text = 'done', structured, error, tools = [], completed = true, tokens } = {}) {
  return {
    info: { id: `msg_a${Math.random().toString(16).slice(2, 8)}`, role: 'assistant', sessionID, parentID, time: completed ? { created: 1, completed: 2 } : { created: 1 }, ...(structured !== undefined && { structured }), ...(error && { error }), ...(tokens && { tokens, cost: 0.5 }) },
    parts: [...tools.map((t, i) => ({ id: `prt_t${i}`, type: 'tool', tool: t.tool, callID: `c${i}`, state: { status: t.status ?? 'completed', input: t.input ?? {} } })), ...(text ? [{ id: 'prt_x', type: 'text', text }] : [])],
  };
}

function setStatus(hub, api, sessionID, status) {
  if (status.type === 'idle') delete api.statusMap[sessionID];
  else api.statusMap[sessionID] = status;
  hub.emit({ type: 'session.status', properties: { sessionID, status } });
}

function completeTurn(hub, api, sessionID, body, opts = {}) {
  setStatus(hub, api, sessionID, { type: 'busy' });
  api.store[sessionID].push(assistant(sessionID, body.messageID, opts));
  setStatus(hub, api, sessionID, { type: 'idle' });
  hub.emit({ type: 'session.idle', properties: { sessionID } });
}


test('newMessageId keeps the V2 ascending id layout', () => {
  const ids = Array.from({ length: 50 }, () => newMessageId());
  for (const id of ids) assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] < ids[i]);
});

test('V2 tool names map to progress phases', () => {
  for (const name of ['read', 'grep', 'glob', 'webfetch', 'websearch']) assert.equal(phaseFromPart({ type: 'tool', name }), 'investigating');
  for (const name of ['edit', 'write', 'apply_patch', 'patch']) assert.equal(phaseFromPart({ type: 'tool', name }), 'editing');
  assert.equal(phaseFromPart({ type: 'tool', name: 'subagent' }), 'subagent');
  assert.equal(phaseFromPart({ type: 'tool', name: 'shell', state: { input: { command: 'npm test' } } }), 'verifying');
  assert.equal(phaseFromPart({ type: 'tool', name: 'shell', state: { input: { command: 'ls' } } }), 'running');
  assert.equal(phaseFromPart({ type: 'text' }), 'running');
});

test('turnMessages stops at first idle and excludes prior turns', () => {
  const messages = [
    { id: 'old', type: 'user' }, { id: 'old_a', type: 'assistant' }, { type: 'idle', outcome: 'succeeded' },
    { id: 'current', type: 'user' }, { id: 'a', type: 'assistant' }, { type: 'idle', outcome: 'succeeded' },
    { id: 'future', type: 'user' }, { id: 'future_a', type: 'assistant' },
  ];
  assert.deepEqual(turnMessages(messages, 'current'), messages.slice(4, 6));
  assert.deepEqual(turnMessages(messages, 'missing'), []);
});

test('extractTurn uses last assistant text and V2 tool, error and usage shapes', () => {
  const turn = [
    { type: 'assistant', id: 'a', content: [{ type: 'text', text: 'old' }, { type: 'tool', name: 'edit', state: { status: 'completed', input: { path: 'a.js' } } }], cost: 0.5, tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } } },
    { type: 'assistant', id: 'b', content: [{ type: 'text', text: 'final' }], error: { type: 'provider.rate-limit', message: '429' }, cost: 0.1, tokens: { input: 7, output: 8 } },
  ];
  const result = extractTurn(turn, { diffs: [{ file: 'b.js' }] });
  assert.equal(result.finalText, 'final');
  assert.deepEqual(result.toolNames, ['edit']);
  assert.deepEqual(result.touchedFiles, ['a.js', 'b.js']);
  assert.equal(result.usage.input, 9);
  assert.equal(result.usage.cacheRead, 4);
  assert.equal(result.usage.cost, 0.6);
  assert.deepEqual(result.error, { name: 'provider.rate-limit', data: { message: '429' } });
});

test('extractTurn keeps the last assistant text when a later assistant has tools only', () => {
  const turn = [
    { type: 'assistant', content: [{ type: 'text', text: 'resposta' }] },
    { type: 'assistant', content: [{ type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'a' } } }] },
  ];
  assert.equal(extractTurn(turn).finalText, 'resposta');
});

test('V2 session model and agent are changed only when different on resume', async () => {
  const { api, hub, emit } = memoryV2();
  api.createdBody = { model: { providerID: 'p', id: 'm' }, agent: 'build', permissions: [{ action: '*', resource: '*', effect: 'deny' }] };
  const pending = runTurn({ api, hub, request: { sessionID: 'ses_mem1', model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] } });
  await api.promptSettled;
  api.messagesFor('ses_mem1', [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_mem1' } });
  assert.equal((await pending).status, 'completed');
  assert.deepEqual(api.calls, []);
});

test('V2 resume replaces permissions and switches model and agent when needed', async () => {
  const { api, hub, emit } = memoryV2();
  api.createdBody = { model: { providerID: 'other', id: 'old' }, agent: 'plan', permissions: [] };
  const rules = [{ action: '*', resource: '*', effect: 'deny' }];
  api.setPermissions = async (id, value) => { api.calls.push(['setPermissions', id, value]); api.createdBody.permissions = value; };
  const pending = runTurn({ api, hub, request: { sessionID: 'ses_mem1', model: { providerID: 'p', modelID: 'm' }, agent: 'build', patchPermission: rules, parts: [{ type: 'text', text: 'hi' }] } });
  await api.promptSettled;
  api.messagesFor('ses_mem1', [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_mem1' } });
  assert.equal((await pending).status, 'completed');
  assert.deepEqual(api.calls.map(([name]) => name), ['setPermissions', 'setModel', 'setAgent']);
});

test('V2 reconnect resync recovers a completed turn without SSE', async () => {
  const { api, hub, emit } = memoryV2();
  let reconnect;
  hub.onReconnect = (handler) => { reconnect = handler; return () => {}; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], statusPollMs: 20 } });
  const id = await api.created;
  await api.promptSettled;
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'recovered' }] }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.started', data: { sessionID: 'other' } });
  api.sessionStatus = async () => ({});
  reconnect();
  assert.equal((await pending).finalText, 'recovered');
});

test('V2 request events are normalized and child permissions are inherited', async () => {
  const { api, hub, emit } = memoryV2();
  const seen = [];
  const rules = [{ action: '*', resource: '*', effect: 'deny' }];
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: rules }, childPermission: [{ action: 'shell', resource: '*', effect: 'allow' }], model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] }, onPermission: async (req) => seen.push(req), onQuestion: async (req) => seen.push(req), onRequestResolved: async (req) => seen.push(req) });
  const id = await api.created;
  await api.promptSettled;
  emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: id } });
  emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_child', action: 'shell', resources: ['ls'], save: [], source: { type: 'tool' } } });
  emit({ type: 'form.created', data: { form: { id: 'frm_1', sessionID: id, title: 'Pergunta', metadata: { kind: 'question' }, fields: [{ key: 'choice', title: 'Escolha', type: 'select', options: [] }] } } });
  emit({ type: 'permission.replied', data: { sessionID: 'ses_child', requestID: 'per_1', reply: 'reject' } });
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: id } });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.childSessionIDs, ['ses_child']);
  assert.equal(seen[0].permission, 'shell');
  assert.equal(seen[1].id, 'frm_1');
  assert.equal(seen[2].requestID, 'per_1');
  assert.deepEqual(api.createdBody.permissions, rules);
  assert.deepEqual((await api.getSession('ses_child')).permissions, rules);
  assert.equal(api.calls.some(([name]) => name === 'setPermissions'), false);
});

test('V2 callback failure interrupts child before parent', async () => {
  const { api, hub, emit } = memoryV2();
  api.interrupt = async (id) => { api.calls.push(['interrupt', id]); return true; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], idleWaitMs: 5 }, onPermission: async () => { throw new Error('falha na ponte'); } });
  const id = await api.created;
  await api.promptSettled;
  emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: id } });
  emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_child', action: 'shell', resources: [], save: [] } });
  const result = await pending;
  assert.equal(result.errorCode, 'CALLBACK_FAILED');
  assert.deepEqual(api.calls.filter(([name]) => name === 'interrupt').map(([, sid]) => sid), ['ses_child', id]);
});

test('V2 retry cap interrupts and classifies the failure', async () => {
  const { api, hub, emit } = memoryV2();
  api.interrupt = async (id) => { api.calls.push(['interrupt', id]); api.sessionStatus = async () => ({}); return true; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], fallbackCfg: { maxProviderRetries: 3 } } });
  const id = await api.created;
  await api.promptSettled;
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }]);
  emit({ type: 'session.retry.scheduled', data: { sessionID: id, attempt: 4, at: Date.now() + 1000, error: { type: 'provider.transport', message: 'retry' } } });
  const result = await pending;
  assert.equal(result.errorCode, 'retry_cap');
  assert.equal(result.errorClass, 'recoverable');
  assert.ok(api.calls.some(([name]) => name === 'interrupt'));
});

test('V2 cancellation interrupts the active session', async () => {
  const { api, hub } = memoryV2();
  const controller = new AbortController();
  api.interrupt = async (id) => { api.calls.push(['interrupt', id]); api.sessionStatus = async () => ({}); return true; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] }, signal: controller.signal });
  await api.promptSettled;
  api.messagesFor('ses_mem1', [{ id: api.lastPromptId(), type: 'user' }]);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.ok(api.calls.some(([name]) => name === 'interrupt'));
});

test('tool error summary never echoes long external input', () => {
  assert.equal(toolErrorSummary('abcdefghijklmnop'), 'abcdefghijkl…');
});

test('V2 shell events use the called command to report verification', async () => {
  const { api, hub, emit } = memoryV2();
  const phases = [];
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] }, onProgress: (event) => { if (event.phase) phases.push(event.phase); } });
  const id = await api.created;
  await api.promptSettled;
  emit({ type: 'session.tool.input.started', data: { sessionID: id, id: 'call_1', name: 'shell' } });
  emit({ type: 'session.tool.called', data: { sessionID: id, id: 'call_1', input: { command: 'npm test' } } });
  emit({ type: 'session.tool.success', data: { sessionID: id, id: 'call_1' } });
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: id } });
  const result = await pending;
  assert.ok(phases.includes('verifying'));
  assert.equal(result.toolsRan, true);
});

test('V2 resync classifies failed idle even without assistant', async () => {
  const { api, hub } = memoryV2();
  let reconnect;
  hub.onReconnect = (handler) => { reconnect = handler; return () => {}; };
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] } });
  const id = await api.created;
  await api.promptSettled;
  api.sessionStatus = async () => ({});
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'failed' }]);
  reconnect();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorType, 'execution.failed');
  assert.equal(result.errorMessage, 'A execução falhou.');
});

test('V2 aborted provider error cancels the turn', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }] } });
  const id = await api.created;
  await api.promptSettled;
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'failed' }]);
  emit({ type: 'session.execution.failed', data: { sessionID: id, error: { type: 'aborted', message: 'private value' } } });
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'cancelled');
  assert.equal(result.errorMessage, 'Turno cancelado.');
});

test('V2 prompt joins only text parts and places model and variant on session', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = runTurn({ api, hub, request: { newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] }, model: { providerID: 'p', modelID: 'm' }, variant: 'high', parts: [{ type: 'text', text: 'one' }, { type: 'file', path: 'ignored' }, { type: 'text', text: 'two' }] } });
  const id = await api.created;
  await api.promptSettled;
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm', variant: 'high' });
  assert.deepEqual(api.promptCalls[0], { id: api.lastPromptId(), text: 'one\ntwo' });
  api.messagesFor(id, [{ id: api.lastPromptId(), type: 'user' }, { type: 'idle', outcome: 'succeeded' }]);
  emit({ type: 'session.execution.succeeded', data: { sessionID: id } });
  assert.equal((await pending).status, 'completed');
});
