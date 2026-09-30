import test from 'node:test';
import assert from 'node:assert/strict';
import { newMessageId, phaseFromPart, runTurn, turnMessages, extractTurn, toolErrorSummary } from '../../plugins/opc/scripts/lib/runner.mjs';
import { ConnectionError, RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

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

test('newMessageId: msg_ + 26 chars, strictly ascending', () => {
  const ids = Array.from({ length: 50 }, () => newMessageId());
  for (const id of ids) assert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i - 1] < ids[i], `${ids[i - 1]} < ${ids[i]}`);
});

test('phaseFromPart maps tools to phases', () => {
  assert.equal(phaseFromPart({ type: 'tool', tool: 'grep', state: {} }), 'investigating');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'apply_patch', state: {} }), 'editing');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }), 'verifying');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }), 'running');
  assert.equal(phaseFromPart({ type: 'tool', tool: 'task', state: {} }), 'subagent');
  assert.equal(phaseFromPart({ type: 'text', text: 'x' }), 'running');
  assert.equal(phaseFromPart({ type: 'step-finish' }), null);
  assert.equal(phaseFromPart({ type: 'tool', tool: 'StructuredOutput', state: {} }), 'finalizing');
});

test('completed turn: text, structured, tools, touched files, usage, body', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body, { text: 'final answer', structured: { ok: true }, tools: [{ tool: 'edit', input: { filePath: 'src/a.js' } }, { tool: 'read', input: { filePath: 'b.js' } }], tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } }) });
  api.diffs.ses_new = [{ file: 'src/c.js', additions: 1, deletions: 0 }];
  const phases = [];
  const r = await runTurn({ api, hub, request: baseRequest({ agent: 'build', variant: 'high' }), onProgress: (e) => e.phase && phases.push(e.phase) });
  assert.equal(r.status, 'completed');
  assert.equal(r.finalText, 'final answer');
  assert.deepEqual(r.structured, { ok: true });
  assert.deepEqual(r.touchedFiles, ['src/a.js', 'src/c.js']);
  assert.equal(r.toolsRan, true);
  assert.equal(r.usage.input, 10);
  assert.equal(r.usage.cost, 0.5);
  const prompt = api.calls.find((c) => c[0] === 'promptAsync');
  assert.deepEqual(prompt[2].model, MODEL);
  assert.equal(prompt[2].agent, 'build');
  assert.equal(prompt[2].variant, 'high');
  assert.match(prompt[2].messageID, /^msg_/);
  assert.ok(phases.includes('starting'));
  assert.ok(phases.includes('running'));
});

test('stale idle before any activity is ignored', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    hub.emit({ type: 'session.idle', properties: { sessionID: sid } });
    setTimeout(() => completeTurn(hub, api, sid, body, { text: 'late' }), 120);
  } });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'completed');
  assert.equal(r.finalText, 'late');
});

test('idle after busy without this turn completed assistant message fails clearly', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    api.store[sid].push(assistant(sid, 'msg_prior_turn', { text: 'stale answer' }));
    setStatus(hub, api, sid, { type: 'busy' });
    setStatus(hub, api, sid, { type: 'idle' });
  } });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'NO_ASSISTANT_MESSAGE');
});

test('session.error ends the turn with the received error', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'session.error', properties: { sessionID: sid, error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'bad key' } } } });
  } });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'ProviderAuthError');
  assert.equal(r.errorClass, 'fatal');
});

test('retry status reports retrying; over cap aborts and is recoverable', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    setStatus(hub, api, sid, { type: 'retry', attempt: 1, message: '429', next: Date.now() + 1000 });
    setStatus(hub, api, sid, { type: 'retry', attempt: 4, message: '429', next: Date.now() + 1000 });
    setTimeout(() => {
      api.store[sid].push(assistant(sid, body.messageID, { text: '', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }));
      setStatus(hub, api, sid, { type: 'idle' });
      hub.emit({ type: 'session.idle', properties: { sessionID: sid } });
    }, 50);
  } });
  const phases = [];
  const r = await runTurn({ api, hub, request: baseRequest(), onProgress: (e) => e.phase && phases.push(e.phase) });
  assert.ok(phases.includes('retrying'));
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'RetryCapExceeded');
  assert.equal(r.errorClass, 'recoverable');
});

test('turn timeout aborts and is recoverable', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => setStatus(hub, api, sid, { type: 'busy' }) });
  api.statusMap.ses_new = { type: 'busy' };
  const r = await runTurn({ api, hub, request: baseRequest({ timeoutMs: 150 }) });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'Timeout');
  assert.equal(r.errorCode, 'turn_timeout');
  assert.equal(r.errorClass, 'recoverable');
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
});

test('abort signal cancels the turn', async () => {
  const hub = stubHub();
  const controller = new AbortController();
  const api = stubApi({ hub, onPrompt: (sid) => { setStatus(hub, api, sid, { type: 'busy' }); setTimeout(() => controller.abort(), 30); } });
  const r = await runTurn({ api, hub, request: baseRequest(), signal: controller.signal });
  assert.equal(r.status, 'cancelled');
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
});

test('already aborted signal cancels before prompt_async', async () => {
  const hub = stubHub();
  const controller = new AbortController();
  controller.abort();
  const api = stubApi({ hub });
  const r = await runTurn({ api, hub, request: baseRequest(), signal: controller.signal });
  assert.equal(r.status, 'cancelled');
  assert.ok(!api.calls.some((c) => c[0] === 'promptAsync'));
});

test('SERVER_DOWN during session creation is returned as server_lost', async () => {
  const hub = stubHub();
  const api = stubApi({ hub });
  api.createSession = async () => { throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'server_lost');
  assert.equal(r.sessionID, null);
});

test('SERVER_DOWN during resume permission patch is returned as server_lost', async () => {
  const hub = stubHub();
  const api = stubApi({ hub });
  api.patchSession = async () => { throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
  const r = await runTurn({ api, hub, request: baseRequest({ newSession: undefined, sessionID: 'ses_old', patchPermission: [{ permission: '*', pattern: '*', action: 'deny' }] }) });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'server_lost');
  assert.equal(r.sessionID, 'ses_old');
});

test('retry recovered by resync still enforces retry cap', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    api.statusMap[sid] = { type: 'retry', attempt: 4, message: '429' };
  } });
  const phases = [];
  const r = await runTurn({ api, hub, request: baseRequest({ fallbackCfg: { maxProviderRetries: 3, maxRetryWaitSec: 60 } }), onProgress: (e) => e.phase && phases.push(e.phase) });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'RetryCapExceeded');
  assert.equal(r.errorClass, 'recoverable');
  assert.ok(phases.includes('retrying'));
  assert.ok(api.calls.some((c) => c[0] === 'abort'));
});

test('server down during polling → server_lost, session preserved', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => setStatus(hub, api, sid, { type: 'busy' }) });
  api.sessionStatus = async () => { throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'server_lost');
  assert.equal(r.sessionID, 'ses_new');
  assert.match(r.errorMessage, /--resume/);
});

test('400 on prompt_async is a fatal BadRequest', async () => {
  const hub = stubHub();
  const api = stubApi({ hub });
  api.promptAsync = async () => { throw new RequestError('BAD_REQUEST', 'invalid body'); };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorType, 'BadRequest');
  assert.equal(r.errorClass, 'fatal');
});

test('400 on prompt_async keeps the server reason, masked and first line only', async () => {
  const hub = stubHub();
  const api = stubApi({ hub });
  const token = ['sk', 'proj', 'Z9y8X7w6V5u4T3s2'].join('-');
  api.promptAsync = async () => {
    throw new RequestError('BAD_REQUEST', 'recusada', { details: { status: 400, body: { name: 'BadRequest', data: { message: `Agent explore is a subagent (${token})\nsecond line` } } } });
  };
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.errorType, 'BadRequest');
  assert.match(r.errorMessage, /^A requisição do turno foi rejeitada: Agent explore is a subagent/);
  assert.ok(!r.errorMessage.includes(token), r.errorMessage);
  assert.ok(!r.errorMessage.includes('second line'), r.errorMessage);
});

test('prompt_async timeout: resend only when the messageID did not arrive', async () => {
  for (const arrived of [true, false]) {
    const hub = stubHub();
    let attempts = 0;
    const api = stubApi({ hub });
    api.promptAsync = async (sid, body) => {
      attempts += 1;
      const deliver = () => {
        api.store[sid].push({ info: { id: body.messageID, role: 'user' }, parts: [] });
        setTimeout(() => completeTurn(hub, api, sid, body), 20);
      };
      if (attempts === 1) {
        if (arrived) deliver();
        throw new ConnectionError('TIMEOUT', 'timed out');
      }
      deliver();
      return null;
    };
    const r = await runTurn({ api, hub, request: baseRequest() });
    assert.equal(r.status, 'completed');
    assert.equal(attempts, arrived ? 1 : 2);
  }
});

test('permissions/questions from session and child reach callbacks; resync recovers missed ones', async () => {
  const hub = stubHub();
  const seen = [];
  const resolved = [];
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: sid } } });
    hub.emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf x'], metadata: {}, always: [] } });
    hub.emit({ type: 'permission.asked', properties: { id: 'per_other', sessionID: 'ses_unrelated', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] } });
    api.questions.push({ id: 'que_1', sessionID: sid, questions: [{ question: 'Q?', header: 'Q', options: [] }] });
    setTimeout(() => hub.reconnect(), 20);
    setTimeout(() => {
      hub.emit({ type: 'permission.replied', properties: { sessionID: 'ses_child', requestID: 'per_1', reply: 'reject' } });
      completeTurn(hub, api, sid, body);
    }, 80);
  } });
  const r = await runTurn({
    api, hub, request: baseRequest({ childPermission: [{ permission: 'bash', pattern: 'rm -rf*', action: 'ask' }] }),
    onPermission: async (req) => seen.push(req.id),
    onQuestion: async (req) => seen.push(req.id),
    onRequestResolved: async (ev) => resolved.push(ev.requestID),
  });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen.sort(), ['per_1', 'que_1']);
  assert.deepEqual(resolved, ['per_1']);
  assert.deepEqual(r.childSessionIDs, ['ses_child']);
  assert.ok(api.calls.some((c) => c[0] === 'patchSession' && c[1] === 'ses_child'));
  assert.deepEqual(api.calls.find((c) => c[0] === 'patchSession' && c[1] === 'ses_child')[2].permission, [{ permission: 'bash', pattern: 'rm -rf*', action: 'ask' }]);
});

test('child permission patch failure fails the turn', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: sid } } });
    setTimeout(() => completeTurn(hub, api, sid, body), 20);
  } });
  api.patchSession = async (id, body) => {
    api.calls.push(['patchSession', id, body]);
    return { id, permission: [] };
  };
  const r = await runTurn({ api, hub, request: baseRequest({ childPermission: [{ permission: 'bash', pattern: '*', action: 'ask' }] }) });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'CHILD_PERMISSION_FAILED');
});

test('permission callback failure fails instead of only reporting progress', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'permission.asked', properties: { id: 'per_throw', sessionID: sid, permission: 'bash', patterns: [] } });
  } });
  const r = await runTurn({ api, hub, request: baseRequest(), onPermission: async () => { throw new Error('callback broke'); } });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'CALLBACK_FAILED');
});

test('question callback failure fails instead of only reporting progress', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid) => {
    setStatus(hub, api, sid, { type: 'busy' });
    hub.emit({ type: 'question.asked', properties: { id: 'que_throw', sessionID: sid, questions: [] } });
  } });
  const r = await runTurn({ api, hub, request: baseRequest(), onQuestion: async () => { throw new Error('callback broke'); } });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'CALLBACK_FAILED');
});

test('resume with patchPermission verifies the returned rules', async () => {
  const hub = stubHub();
  const rules = [{ permission: '*', pattern: '*', action: 'deny' }];
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body), extra: { existingPermission: [{ permission: 'x', pattern: '*', action: 'allow' }] } });
  api.store.ses_old = [];
  const r = await runTurn({ api, hub, request: baseRequest({ newSession: undefined, sessionID: 'ses_old', patchPermission: rules }) });
  assert.equal(r.status, 'completed');
  assert.equal(r.sessionID, 'ses_old');
  assert.ok(!api.calls.some((c) => c[0] === 'createSession'));
});

test('turnMessages falls back to messages after the user message', () => {
  const list = [{ info: { id: 'msg_u', role: 'user' } }, { info: { id: 'msg_a', role: 'assistant' }, parts: [] }];
  assert.equal(turnMessages(list, 'msg_u').length, 1);
  assert.equal(turnMessages(list, 'msg_missing').length, 0);
});

test('extractTurn: apply_patch files and structured error keeps raw text', () => {
  const turn = [{ info: { role: 'assistant', error: { name: 'StructuredOutputError', data: { message: 'bad', retries: 1 } } }, parts: [
    { type: 'tool', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '*** Begin Patch\n*** Update File: a/b.js\n*** Add File: c.txt\n*** End Patch' } } },
    { type: 'text', text: 'raw answer' },
  ] }];
  const r = extractTurn(turn);
  assert.deepEqual(r.touchedFiles, ['a/b.js', 'c.txt']);
  assert.equal(r.finalText, 'raw answer');
  assert.equal(r.error.name, 'StructuredOutputError');
});

test('StructuredOutput tool does not count as tools ran (StructuredOutputError stays recoverable)', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body, { text: 'raw', tools: [{ tool: 'StructuredOutput', input: { x: 1 } }], error: { name: 'StructuredOutputError', data: { message: 'invalid', retries: 1 } } }) });
  const r = await runTurn({ api, hub, request: baseRequest() });
  assert.equal(r.toolsRan, false);
  assert.equal(r.errorType, 'StructuredOutputError');
  assert.equal(r.errorClass, 'recoverable');
  assert.equal(r.finalText, 'raw');
});

for (const failure of ['patch', 'permission', 'question', 'resolved']) {
  for (const abortMode of ['idle', 'refused', 'throws', 'busy']) {
    test(`gate 3: ${failure} aborts children before parent (${abortMode})`, async () => {
      const hub = stubHub();
      const childID = 'ses_child_gate';
      const api = stubApi({ hub, onPrompt: (sid) => {
        api.statusMap[sid] = { type: 'busy' };
        api.statusMap[childID] = { type: 'busy' };
        hub.emit({ type: 'session.created', properties: { info: { id: childID, parentID: sid } } });
        const type = failure === 'question' ? 'question.asked' : failure === 'resolved' ? 'permission.replied' : 'permission.asked';
        hub.emit({ type, properties: { id: 'per_gate', requestID: 'per_gate', sessionID: childID, permission: 'bash', patterns: [] } });
      } });
      if (failure === 'patch') api.patchSession = async () => { throw new Error('falha no PATCH'); };
      const abort = api.abort;
      api.abort = async (id) => {
        if (id === childID && abortMode !== 'idle') {
          api.calls.push(['abort', id]);
          if (abortMode === 'throws') throw new Error('falha no abort');
          return abortMode === 'busy';
        }
        return abort(id);
      };
      const fail = async () => { throw new Error('falha na ponte'); };
      const result = await runTurn({ api, hub,
        request: baseRequest({ idleWaitMs: 5, childPermission: [{ permission: 'bash', pattern: '*', action: 'ask' }] }),
        onPermission: failure === 'permission' ? fail : async () => {},
        onQuestion: failure === 'question' ? fail : async () => {},
        onRequestResolved: failure === 'resolved' ? fail : async () => {},
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.errorCode, failure === 'patch' ? 'CHILD_PERMISSION_FAILED' : 'CALLBACK_FAILED');
      assert.deepEqual(api.calls.filter(([name]) => name === 'abort').map(([, id]) => id), [childID, 'ses_new']);
      assert.equal(result.abortConfirmed, abortMode === 'idle');
      assert.equal(result.sessionAborts.length, 2);
      assert.ok(api.calls.some(([name]) => name === 'sessionStatus'));
    });
  }
}

test('gate 5: progress prints full server IDs and redacts them', async () => {
  const { registerSecret } = await import('../../plugins/opc/scripts/lib/redact.mjs');
  const secret = 'fake-gate-progress-secret';
  registerSecret(secret);
  const sid = 'ses_parent_identifier_long';
  const child = `ses_child_identifier_long_${secret}`;
  const permission = 'per_permission_identifier_long';
  const question = 'que_question_identifier_long';
  const hub = stubHub();
  const lines = [];
  const api = stubApi({ hub, onPrompt: (id, body) => {
    hub.emit({ type: 'session.created', properties: { info: { id: child, parentID: id } } });
    hub.emit({ type: 'permission.asked', properties: { id: permission, sessionID: id, permission: 'bash' } });
    hub.emit({ type: 'question.asked', properties: { id: question, sessionID: id } });
    completeTurn(hub, api, id, body);
  } });
  await runTurn({ api, hub, request: baseRequest({ sessionID: sid }), onProgress: (event) => lines.push(event.message ?? '') });
  for (const id of [sid, child.replace(secret, '***'), permission, question]) assert.ok(lines.some((line) => line.includes(id)), id);
  assert.equal(lines.join('\n').includes(secret), false);
});

test('toolErrorSummary drops the echoed rule list and caps free text', () => {
  const denial = 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"*","pattern":"~/private/**","action":"allow"}]';
  assert.equal(toolErrorSummary(denial), 'The user has specified a rule which prevents you from using this specific tool call.');
  assert.equal(toolErrorSummary('first line\nsecond line'), 'first line');
  const long = toolErrorSummary('x'.repeat(500));
  assert.equal(long.length, 201);
  assert.ok(long.endsWith('…'));
  assert.equal(toolErrorSummary(undefined), '');
});

for (const mode of ['false', 'throws', 'busy', 'delayed-idle']) {
  test(`F4a C1: retry cap requires confirmed abort (${mode})`, async () => {
    const hub = stubHub();
    const api = stubApi({ hub, onPrompt: (sid) => setStatus(hub, api, sid, { type: 'retry', attempt: 4 }) });
    let idleObserved = false;
    api.abort = async (sid) => {
      if (mode === 'throws') throw new Error('abort unavailable');
      if (mode === 'delayed-idle') setTimeout(() => { delete api.statusMap[sid]; idleObserved = true; }, 10);
      return mode !== 'false';
    };
    const result = await runTurn({ api, hub, request: baseRequest({ timeoutMs: 400, idleWaitMs: mode === 'delayed-idle' ? 350 : 20 }) });
    assert.equal(result.errorType, mode === 'delayed-idle' ? 'RetryCapExceeded' : 'AbortUnconfirmed');
    assert.equal(result.errorClass, mode === 'delayed-idle' ? 'recoverable' : 'fatal');
    if (mode === 'delayed-idle') assert.equal(idleObserved, true);
  });
}

test('I4: generic textJson validator extracts a planner JSON fence without sending format', async () => {
  const plan = { rationale: 'r', subtasks: [] };
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body, { text: '\x60\x60\x60json\n' + JSON.stringify(plan) + '\n\x60\x60\x60' }) });
  const result = await runTurn({ api, hub, request: baseRequest({ textJson: () => null }) });
  assert.deepEqual(result.structured, plan);
  assert.equal(result.structuredSource, 'text');
  assert.equal(Object.hasOwn(api.calls.find(([name]) => name === 'promptAsync')[2], 'format'), false);
});

test('C1: session callback completes before prompt and tracks children', async () => {
  const saved = [];
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => {
    assert.deepEqual(saved, [{ sessionID: sid, childSessionIDs: [] }]);
    hub.emit({ type: 'session.created', properties: { info: { id: 'ses_child', parentID: sid } } });
    completeTurn(hub, api, sid, body);
  } });
  await runTurn({ api, hub, request: baseRequest(), onSession: async (event) => { await new Promise((r) => setImmediate(r)); saved.push(event); } });
  assert.deepEqual(saved.at(-1), { sessionID: 'ses_new', childSessionIDs: ['ses_child'] });
});

test('C2: failed session persistence aborts before sending the prompt', async () => {
  const hub = stubHub();
  const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body) });
  const result = await runTurn({ api, hub, request: baseRequest(), onSession: async () => { throw new Error('storage failed'); } });
  assert.equal(result.errorType, 'CallbackFailed');
  assert.equal(result.abortConfirmed, true);
  assert.equal(api.calls.some(([name]) => name === 'promptAsync'), false);
  assert.ok(api.calls.some(([name]) => name === 'abort'));
});

for (const stage of ['createSession', 'onSession']) {
  for (const abortMode of ['ok', 'server-down']) {
    test(`F4b fix2: cancellation during ${stage} prevents prompting (${abortMode})`, async () => {
      const hub = stubHub();
      const api = stubApi({ hub, onPrompt: (sid, body) => completeTurn(hub, api, sid, body) });
      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      const blocked = new Promise((resolve) => { release = resolve; });
      let cancelled = false;
      const pause = async () => { entered(); await blocked; };
      if (stage === 'createSession') {
        const create = api.createSession;
        api.createSession = async (body) => { await pause(); return create(body); };
      }
      if (abortMode === 'server-down') api.abort = async (id) => {
        api.calls.push(['abort', id]);
        throw new ConnectionError('SERVER_DOWN', 'connection refused');
      };
      const running = runTurn({ api, hub, request: baseRequest(),
        isCancelled: () => cancelled, onSession: stage === 'onSession' ? pause : async () => {},
      });
      await started;
      cancelled = true;
      release();
      const result = await running;
      assert.equal(api.calls.some(([name]) => name === 'promptAsync'), false);
      assert.ok(api.calls.some(([name, id]) => name === 'abort' && id === 'ses_new'));
      assert.equal(result.status, 'cancelled');
      assert.equal(result.errorType, 'Cancelled');
      assert.equal(result.toolsRan, false);
      assert.deepEqual(hub.tracked, []);
    });
  }
}
