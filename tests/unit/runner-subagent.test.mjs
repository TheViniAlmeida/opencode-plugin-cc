import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { dispatchSubagent, isAgentModeRefusal, extractTaskOutput, SUBAGENT_MECHANISMS } from '../../plugins/opc/scripts/lib/runner.mjs';

const RULES = [{ permission: '*', pattern: '*', action: 'deny' }];
const MEMBER = { agent: 'explore', model: { providerID: 'p', modelID: 'm/x' }, title: 'OPC: sub: #1 explore: hi' };

function fakeApi({ refuseCreateWithAgent = false, messages = [] } = {}) {
  const created = [];
  return {
    created,
    async createSession(body) {
      if (refuseCreateWithAgent && body.agent) {
        const err = new Error('Agent explore is a subagent and cannot be used as the session agent');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      created.push(body);
      return { id: `ses_${created.length}` };
    },
    async messages() { return messages; },
  };
}

const okTurn = (text = 'done') => async ({ request }) => ({ status: 'completed', sessionID: request.sessionID, finalText: text, toolsRan: false, childSessionIDs: [] });

test('mechanisms and refusal detection', () => {
  assert.deepEqual(SUBAGENT_MECHANISMS, ['child-session', 'subtask']);
  assert.equal(isAgentModeRefusal(new Error('Agent explore is a subagent and cannot be used as the session agent')), true);
  assert.equal(isAgentModeRefusal({ status: 'failed', errorType: 'BadRequest', errorMessage: 'agent "x" mode primary required' }), true);
  assert.equal(isAgentModeRefusal(new Error('invalid api key')), false);
  assert.equal(isAgentModeRefusal(null), false);
});

test('extractTaskOutput returns the last completed task tool output', () => {
  const messages = [
    { info: {}, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: 'first' } }] },
    { info: {}, parts: [{ type: 'tool', tool: 'read', state: { status: 'completed', output: 'nope' } }, { type: 'tool', tool: 'task', state: { status: 'completed', output: 'second' } }] },
  ];
  assert.equal(extractTaskOutput(messages), 'second');
  assert.equal(extractTaskOutput([]), '');
});

test('child-session: creates child with parentID/agent/rules, then runs the turn with the agent', async () => {
  const api = fakeApi();
  const seen = [];
  const sessions = [];
  const onRequestResolved = async () => {};
  let forwarded = null;
  const res = await dispatchSubagent({
    api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'hi "there"', rules: RULES,
    onSession: (sid) => sessions.push(sid), onRequestResolved,
    runTurnImpl: async (args) => { seen.push(args.request); forwarded = args.onRequestResolved; return okTurn()(args); },
  });
  assert.equal(forwarded, onRequestResolved, 'onRequestResolved reaches runTurn (bridge release)');
  assert.deepEqual(api.created, [{ parentID: 'ses_parent', title: MEMBER.title, agent: 'explore', permission: RULES }]);
  assert.deepEqual(sessions, ['ses_1']);
  assert.equal(seen[0].sessionID, 'ses_1');
  assert.equal(seen[0].agent, 'explore');
  assert.deepEqual(seen[0].model, MEMBER.model);
  assert.deepEqual(seen[0].parts, [{ type: 'text', text: 'hi "there"' }]);
  assert.match(seen[0].messageID, /^msg/);
  assert.equal(res.mechanism, 'child-session');
  assert.equal(res.fellBack, false);
});

test('falls back to a subtask part when createSession refuses the agent mode', async () => {
  const api = fakeApi({ refuseCreateWithAgent: true });
  const seen = [];
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, runTurnImpl: async (args) => { seen.push(args.request); return okTurn('sub ok')(args); } });
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].agent, undefined);
  assert.deepEqual(api.created[0].permission.at(-1), { permission: 'task', pattern: 'explore', action: 'allow' });
  assert.deepEqual(seen[0].parts, [{ type: 'subtask', prompt: 'p', description: MEMBER.title, agent: 'explore', model: MEMBER.model }]);
  assert.equal(res.mechanism, 'subtask');
  assert.equal(res.fellBack, true);
  assert.equal(res.carrierSessionID, 'ses_1');
});

test('falls back when the turn fails with an agent-mode refusal', async () => {
  const api = fakeApi();
  let call = 0;
  const res = await dispatchSubagent({
    api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES,
    runTurnImpl: async ({ request }) => {
      call += 1;
      if (call === 1) return { status: 'failed', sessionID: request.sessionID, errorType: 'BadRequest', errorMessage: 'Agent explore is a subagent and cannot be used as the session agent', finalText: '' };
      return { status: 'completed', sessionID: request.sessionID, finalText: 'ok' };
    },
  });
  assert.equal(res.mechanism, 'subtask');
  assert.equal(res.fellBack, true);
  assert.equal(api.created.length, 2);
});

test('subtask with empty final text reads the task tool output', async () => {
  const api = fakeApi({ messages: [{ info: {}, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: 'TASK OUT' } }] }] });
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'subtask', runTurnImpl: okTurn('') });
  assert.equal(res.finalText, 'TASK OUT');
  assert.equal(res.fellBack, false);
  assert.equal(api.created.length, 1);
});

test('subtask fallback masks the task tool output (registered secrets and token patterns)', async () => {
  const secret = ['reg', 'secret', 'value', '4f9a2c7e'].join('-');
  registerSecret(secret);
  const token = ['sk', 'proj', 'A1b2C3d4E5f6G7h8'].join('-');
  const api = fakeApi({ messages: [{ info: {}, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: `key ${secret} and ${token}` } }] }] });
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'subtask', runTurnImpl: okTurn('') });
  assert.ok(!res.finalText.includes(secret), res.finalText);
  assert.ok(!res.finalText.includes(token), res.finalText);
  assert.match(res.finalText, /^key /);
});

test('subtask fallback reads messages through the list-bug-aware reader (per-message reads after a 400)', async () => {
  const listErr = Object.assign(new Error('Bad Request'), { code: 'BAD_REQUEST', details: { body: { message: 'Expected OutputFormatJsonSchema' } } });
  const api = {
    created: [],
    async createSession(body) { this.created.push(body); return { id: `ses_${this.created.length}` }; },
    async messages() { throw listErr; },
    async message(sessionID, messageID) {
      assert.equal(messageID, 'msg_a');
      return { info: { id: 'msg_a' }, parts: [{ type: 'tool', tool: 'task', state: { status: 'completed', output: 'VIA PER-MESSAGE' } }] };
    },
  };
  const { rememberMessage } = await import('../../plugins/opc/scripts/lib/session-messages.mjs');
  rememberMessage(api, 'ses_1', 'msg_a'); // the turn remembers the ids it produced
  const res = await dispatchSubagent({ api, hub: {}, parentSessionID: 'ses_parent', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'subtask', runTurnImpl: okTurn('') });
  assert.equal(res.finalText, 'VIA PER-MESSAGE');
});

test('non-refusal errors propagate; allowFallback=false never falls back; bad mechanism is a usage error', async () => {
  const boom = async () => { throw new Error('invalid api key'); };
  await assert.rejects(dispatchSubagent({ api: fakeApi(), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, runTurnImpl: boom }), /invalid api key/);
  await assert.rejects(dispatchSubagent({ api: fakeApi({ refuseCreateWithAgent: true }), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, allowFallback: false, runTurnImpl: okTurn() }), /subagent/);
  await assert.rejects(dispatchSubagent({ api: fakeApi(), hub: {}, parentSessionID: 'p', member: MEMBER, prompt: 'p', rules: RULES, mechanism: 'magic', runTurnImpl: okTurn() }), (e) => e.code === 'INVALID_MECHANISM' && e.exitCode === 2);
});
