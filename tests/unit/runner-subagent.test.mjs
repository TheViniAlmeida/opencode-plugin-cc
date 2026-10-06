import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { dispatchSubagent, extractTaskOutput, isAgentModeRefusal, runTurn, SUBAGENT_MECHANISMS } from '../../plugins/opc/scripts/lib/runner.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { memoryV2 } from './_memory-v2.mjs';
import refusedScenario from '../fixtures/scenarios/subagent-mode-refused.mjs';

const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const member = { agent: 'explore', model: { providerID: 'p', modelID: 'm' }, title: 'OPC: sub: explore' };
const taskPart = (text) => ({ type: 'tool', name: 'subagent', state: { status: 'completed', content: [{ type: 'text', text }] } });
const turn = (text, tool = false) => async ({ request }) => ({ status: 'completed', sessionID: request.sessionID, finalText: text, toolsRan: tool, childSessionIDs: [] });

function finish(api, emit, sessionID, text, { tool = false } = {}) {
  api.messagesFor(sessionID, [
    { id: api.lastPromptId(), type: 'user', text: api.promptCalls.at(-1).text },
    { id: 'msg_answer', type: 'assistant', content: tool ? [taskPart(text)] : [{ type: 'text', text }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
  ]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
}

test('mechanisms and refusal detection', () => {
  assert.deepEqual(SUBAGENT_MECHANISMS, ['child-session', 'subagent-tool']);
  assert.equal(isAgentModeRefusal(new RequestError('BAD_REQUEST', 'agent "explore" is a subagent')), true);
  assert.equal(isAgentModeRefusal({ status: 'failed', errorType: 'BadRequest', errorMessage: 'agent mode primary required' }), true);
  assert.equal(isAgentModeRefusal(new Error('invalid api key')), false);
});

test('extractTaskOutput reads the last completed subagent tool', () => {
  assert.equal(extractTaskOutput([{ type: 'assistant', content: [taskPart('a'), { type: 'tool', name: 'subagent', state: { status: 'error', error: { message: 'x' } } }] }]), 'a');
  assert.equal(extractTaskOutput([{ type: 'assistant', content: [taskPart('a')] }, { type: 'assistant', content: [taskPart('b')] }]), 'b');
  assert.equal(extractTaskOutput([]), '');
});

test('child-session creates a child with explicit rules and model', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'child-session', allowFallback: false });
  const sessionID = await api.created;
  assert.equal(api.createdBody.parentID, 'ses_parent');
  assert.equal(api.createdBody.agent, 'explore');
  assert.deepEqual(api.createdBody.permissions, RULES);
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
  await api.promptSettled;
  assert.equal(api.promptCalls[0].text, 'find x');
  finish(api, emit, sessionID, 'found');
  const result = await pending;
  assert.equal(result.mechanism, 'child-session');
  assert.equal(result.finalText, 'found');
});

test('failed child session keeps the V2 provider diagnostic for group rendering', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'child-session' });
  const sessionID = await api.created;
  await api.promptSettled;
  api.messagesFor(sessionID, [
    { id: api.lastPromptId(), type: 'user', text: 'find x' },
    { id: 'msg_idle', type: 'idle', outcome: 'failed' },
  ]);
  emit({ type: 'session.execution.failed', data: { sessionID, error: { type: 'provider.auth', message: 'Chave de API inválida.' } } });
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.mechanism, 'child-session');
  assert.match(result.errorMessage, /Chave de API inválida/);
});

test('subagent-tool allows only the member agent and asks for it by name', async () => {
  const { api, hub, emit } = memoryV2();
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'subagent-tool' });
  const sessionID = await api.created;
  assert.deepEqual(api.createdBody.permissions, [...RULES, { action: 'subagent', resource: 'explore', effect: 'allow' }]);
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
  await api.promptSettled;
  assert.deepEqual(api.promptCalls[0].agents, ['explore']);
  assert.equal(api.promptCalls[0].text, 'Use the subagent tool with agent "explore" to do the task below, then reply with the subagent\'s final answer only.\n\nfind x');
  emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: sessionID } });
  assert.deepEqual(await api.getSession('ses_child'), { id: 'ses_child', model: api.createdBody.model, agent: api.createdBody.agent, permissions: api.createdBody.permissions });
  finish(api, emit, sessionID, 'sub answer', { tool: true });
  const result = await pending;
  assert.equal(result.mechanism, 'subagent-tool');
  assert.equal(result.finalText, 'sub answer');
});

test('a refused child agent falls back to the subagent tool', async () => {
  const { api, hub, emit } = memoryV2({ createFailsOnce: new RequestError('BAD_REQUEST', 'agent "explore" is a subagent') });
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'child-session', allowFallback: true });
  const sessionID = await api.created;
  assert.deepEqual(api.createdBody.permissions.at(-1), { action: 'subagent', resource: 'explore', effect: 'allow' });
  await api.promptSettled;
  finish(api, emit, sessionID, 'ok', { tool: true });
  const result = await pending;
  assert.equal(result.fellBack, true);
  assert.equal(result.mechanism, 'subagent-tool');
});

test('integration refusal scenario rejects only direct explore session creation', () => {
  const handler = refusedScenario.routes['POST /api/session'];
  assert.equal(typeof handler, 'function');
  const rejected = handler({}, { body: { agent: 'explore', parentID: 'ses_parent' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.message, /agent.*mode|agent.*subagent/i);
  assert.equal(handler({}, { body: { parentID: 'ses_parent' } }), undefined);
});

test('a prompt refusal mentioning agent mode remains available for fallback', async () => {
  const { api, hub } = memoryV2();
  api.prompt = async () => { throw new RequestError('BAD_REQUEST', 'agent mode primary required'); };
  await assert.rejects(runTurn({ api, hub, request: { model: member.model, agent: member.agent,
    newSession: { title: member.title, permissions: RULES }, parts: [{ type: 'text', text: 'find x' }], agentModeFallback: true } }),
  (error) => error.code === 'BAD_REQUEST');
});

test('a turn agent refusal falls back and forwards request bridge callbacks', async () => {
  const bodies = [];
  const api = { async createSession(body) { bodies.push(body); return { id: `ses_${bodies.length}` }; }, async messages() { return [{ type: 'assistant', content: [taskPart('tool result')] }]; } };
  const seen = [];
  const onRequestResolved = async () => {};
  let calls = 0;
  const result = await dispatchSubagent({ api, hub: {}, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, onRequestResolved,
    runTurnImpl: async (args) => { seen.push(args); calls++; return calls === 1 ? { status: 'failed', errorType: 'BadRequest', errorMessage: 'agent mode primary required' } : turn('')(args); } });
  assert.equal(result.mechanism, 'subagent-tool');
  assert.equal(result.finalText, 'tool result');
  assert.equal(seen[0].onRequestResolved, onRequestResolved);
  assert.equal(seen[1].request.agents[0], 'explore');
  assert.equal(bodies.length, 2);
});

test('subagent tool output is redacted and message errors propagate', async () => {
  const secret = ['reg', 'secret', 'value', '4f9a2c7e'].join('-');
  registerSecret(secret);
  const api = { async createSession() { return { id: 'ses_1' }; }, async messages() { return [{ type: 'assistant', content: [taskPart(`key ${secret}`)] }]; } };
  const args = { api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'subagent-tool', runTurnImpl: turn('') };
  const result = await dispatchSubagent(args);
  assert.equal(result.finalText.includes(secret), false);
  const listErr = new RequestError('BAD_REQUEST', 'Falha ao listar mensagens.');
  await assert.rejects(dispatchSubagent({ ...args, api: { ...api, async messages() { throw listErr; } } }), (error) => error === listErr);
});

test('non-refusal errors propagate, disabled fallback stays off, and bad mechanisms are usage errors', async () => {
  const api = { async createSession() { throw new RequestError('BAD_REQUEST', 'invalid api key'); } };
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES }), /invalid api key/);
  const refused = { async createSession() { throw new RequestError('BAD_REQUEST', 'agent mode primary required'); } };
  await assert.rejects(dispatchSubagent({ api: refused, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, allowFallback: false }), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'magic-value-beyond-preview' }), (error) => error.code === 'INVALID_MECHANISM' && error.exitCode === 2 && error.message.includes('magic-value-…') && !error.message.includes('beyond'));
});
