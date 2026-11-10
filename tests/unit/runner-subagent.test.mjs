import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { DEFAULT_AGENT, dispatchSubagent, extractTaskOutput, isAgentModeRefusal, runTurn, SUBAGENT_MECHANISMS } from '../../plugins/opc/scripts/lib/runner.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { memoryV2 } from './_memory-v2.mjs';
import refusedScenario from '../fixtures/scenarios/subagent-mode-refused.mjs';
import { buildPermissionRules } from '../../plugins/opc/scripts/lib/policy.mjs';
import { globToRegExp } from '../../plugins/opc/scripts/lib/models.mjs';

const RULES = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }];
const ruleInputs = { profile: 'read-only' };
const carrierAllow = { action: 'subagent', resource: 'explore', effect: 'allow' };
const member = { agent: 'explore', model: { providerID: 'p', modelID: 'm' }, title: 'OPC: sub: explore' };
const taskPart = (text) => ({ type: 'tool', name: 'subagent', state: { status: 'completed', content: [{ type: 'text', text }] } });
const turn = (text, tool = false) => async ({ request }) => ({ status: 'completed', sessionID: request.sessionID, finalText: text, toolsRan: tool, childSessionIDs: [] });

for (const mechanism of ['child-session', 'subagent-tool']) {
  test(`dispatch never creates a session for an already cancelled member (${mechanism})`, async () => {
    const { api, hub } = memoryV2();
    let creates = 0;
    api.createSession = async () => { creates += 1; return { id: 'ses_unexpected' }; };
    const result = await dispatchSubagent({ api, hub, parentSessionID: 'ses_parent', member, prompt: 'test', rules: RULES,
      ruleInputs, mechanism, isCancelled: () => true, runTurnImpl: turn('unexpected') });
    assert.equal(result.status, 'cancelled');
    assert.equal(creates, 0);
  });
}

test('carrier checks cancellation again after asynchronous agent discovery', async () => {
  const { api, hub } = memoryV2();
  let cancelled = false; let creates = 0;
  api.agents = async () => { cancelled = true; return []; };
  api.createSession = async () => { creates += 1; return { id: 'ses_unexpected' }; };
  const result = await dispatchSubagent({ api, hub, parentSessionID: 'ses_parent', member, prompt: 'test', rules: RULES,
    ruleInputs, mechanism: 'subagent-tool', isCancelled: () => cancelled, runTurnImpl: turn('unexpected') });
  assert.equal(result.status, 'cancelled');
  assert.equal(creates, 0);
});

test('cancellation after a child refusal prevents creating a fallback carrier', async () => {
  const { api, hub } = memoryV2();
  let cancelled = false; let creates = 0;
  api.createSession = async () => { creates += 1; return { id: 'ses_child' }; };
  const result = await dispatchSubagent({ api, hub, parentSessionID: 'ses_parent', member, prompt: 'test', rules: RULES,
    ruleInputs, isCancelled: () => cancelled, runTurnImpl: async () => {
      cancelled = true;
      throw new RequestError('BAD_REQUEST', 'agent mode primary required');
    } });
  assert.equal(result.status, 'cancelled');
  assert.equal(creates, 1);
});

function finish(api, emit, sessionID, text, { tool = false } = {}) {
  api.messagesFor(sessionID, [
    { id: api.lastPromptId(), type: 'user', text: api.promptCalls.at(-1).text },
    { id: 'msg_answer', type: 'assistant', content: tool ? [taskPart(text)] : [{ type: 'text', text }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
  ]);
  emit({ type: 'session.execution.succeeded', data: { sessionID } });
}

test('mechanisms and refusal detection', () => {
  assert.equal(DEFAULT_AGENT, 'build');
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
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, ruleInputs, mechanism: 'subagent-tool' });
  const sessionID = await api.created;
  assert.deepEqual(api.createdBody.model, { providerID: 'p', id: 'm' });
  await api.promptSettled;
  assert.deepEqual(api.promptCalls[0].agents, ['explore']);
  assert.equal(api.promptCalls[0].text, 'Use the subagent tool with agent "explore" to do the task below, then reply with the subagent\'s final answer only.\n\nfind x');
  emit({ type: 'session.created', data: { sessionID: 'ses_child', parentID: sessionID } });
  assert.deepEqual(await api.getSession('ses_child'), { id: 'ses_child', model: api.createdBody.model, agent: api.createdBody.agent, permissions: api.createdBody.permissions });
  finish(api, emit, sessionID, 'sub answer', { tool: true });
  const result = await pending;
  assert.deepEqual(api.createdBody.permissions, buildPermissionRules('read-only', { extraAllow: [carrierAllow] }));
  assert.equal(result.mechanism, 'subagent-tool');
  assert.equal(result.finalText, 'sub answer');
});

test('a refused child agent falls back to the subagent tool', async () => {
  const { api, hub, emit } = memoryV2({ createFailsOnce: new RequestError('BAD_REQUEST', 'agent "explore" is a subagent') });
  const pending = dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, ruleInputs, mechanism: 'child-session', allowFallback: true });
  const sessionID = await api.created;
  await api.promptSettled;
  finish(api, emit, sessionID, 'ok', { tool: true });
  const result = await pending;
  assert.deepEqual(api.createdBody.permissions, buildPermissionRules('read-only', { extraAllow: [carrierAllow] }));
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
  api.interrupt = async () => { api.sessionStatus = async () => ({}); return false; };
  await assert.rejects(runTurn({ api, hub, request: { model: member.model, agent: member.agent,
    newSession: { title: member.title, permissions: RULES }, parts: [{ type: 'text', text: 'find x' }], agentModeFallback: true, idleWaitMs: 50 } }),
  (error) => error.code === 'BAD_REQUEST');
});

test('a turn agent refusal falls back and forwards request bridge callbacks', async () => {
  const bodies = [];
  const api = { async agents() { return [{ name: 'build', mode: 'primary' }]; }, async createSession(body) { bodies.push(body); return { id: `ses_${bodies.length}` }; }, async messages() { return [{ type: 'assistant', content: [taskPart('tool result')] }]; } };
  const seen = [];
  const onRequestResolved = async () => {};
  let calls = 0;
  const result = await dispatchSubagent({ api, hub: {}, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, ruleInputs, onRequestResolved,
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
  const api = { async agents() { return []; }, async createSession() { return { id: 'ses_1' }; }, async messages() { return [{ type: 'assistant', content: [taskPart(`key ${secret}`)] }]; } };
  const args = { api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, ruleInputs, mechanism: 'subagent-tool', runTurnImpl: turn('') };
  const result = await dispatchSubagent(args);
  assert.equal(result.finalText.includes(secret), false);
  const listErr = new RequestError('BAD_REQUEST', 'Falha ao listar mensagens.');
  await assert.rejects(dispatchSubagent({ ...args, api: { ...api, async messages() { throw listErr; } } }), (error) => error === listErr);
});

for (const policy of [{ tools: { deny: ['subagent'] } }, { agents: { deny: ['expl*'] } }]) {
  test(`subagent-tool refuses policy ${JSON.stringify(policy)} before creating any session`, async () => {
    const bodies = [];
    const api = { async createSession(body) { bodies.push(body); return { id: 'ses_denied' }; } };
    await assert.rejects(dispatchSubagent({ api, hub: {}, member, policy, rules: RULES, ruleInputs,
      mechanism: 'subagent-tool', runTurnImpl: turn('unused') }), (error) => error.code === 'SUBAGENT_DENIED');
    assert.equal(bodies.length, 0);
  });
}

test('a denied subagent tool also blocks automatic fallback before creating a carrier', async () => {
  const bodies = [];
  const api = { async createSession(body) { bodies.push(body); throw new RequestError('BAD_REQUEST', 'agent mode primary required'); } };
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, rules: RULES, ruleInputs,
    policy: { tools: { deny: ['subagent'] } }, mechanism: 'child-session', allowFallback: true }),
  (error) => error.code === 'SUBAGENT_DENIED');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].agent, 'explore');
});

test('carrier rules rebuild custom profiles with allows before all invariants', async () => {
  let body;
  const policy = { tools: { deny: ['shell'] }, agents: { deny: ['work-*'] } };
  const inputs = { profile: 'custom:test-only', permissionProfiles: { 'test-only': [{ action: 'shell', resource: 'npm test', effect: 'allow' }] }, deniedAgentGlobs: ['work-*'] };
  const api = { async agents() { return []; }, async createSession(value) { body = value; return { id: 'ses_carrier' }; } };
  await dispatchSubagent({ api, hub: {}, member, policy, ruleInputs: inputs, rules: buildPermissionRules(inputs.profile, { ...inputs, policy }),
    mechanism: 'subagent-tool', runTurnImpl: turn('ok') });
  const lastMatch = (action, resource) => body.permissions.filter((rule) => (rule.action === '*' || rule.action === action)
    && globToRegExp(rule.resource).test(resource)).at(-1)?.effect;
  assert.equal(lastMatch('subagent', 'explore'), 'allow');
  assert.equal(lastMatch('subagent', 'work-reviewer'), 'deny');
  assert.equal(lastMatch('shell', 'rm -rf x'), 'deny');
  assert.equal(lastMatch('read', '.env'), 'deny');
  assert.ok(body.permissions.indexOf(body.permissions.find((rule) => rule.action === 'subagent' && rule.effect === 'allow'))
    < body.permissions.findIndex((rule) => rule.action === 'external_directory'));
});

test('carrier checks the implicit build agent and its pinned model before creation', async () => {
  for (const [agents, policy] of [
    [[], { agents: { deny: ['build'] } }],
    [[{ name: 'build', mode: 'primary', model: { providerID: 'blocked', modelID: 'model' } }], { providers: { deny: ['blocked'] } }],
  ]) {
    const bodies = [];
    const api = { async agents() { return agents; }, async createSession(body) { bodies.push(body); return { id: 'ses_denied' }; } };
    await assert.rejects(dispatchSubagent({ api, hub: {}, member, policy, rules: RULES, ruleInputs,
      mechanism: 'subagent-tool', runTurnImpl: turn('unused') }), (error) => error.name === 'PolicyError');
    assert.equal(bodies.length, 0);
  }
});

test('carrier refuses missing rule inputs before creating a session', async () => {
  const bodies = [];
  const api = { async createSession(body) { bodies.push(body); return { id: 'ses_unsafe' }; } };
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, rules: RULES, mechanism: 'subagent-tool',
    runTurnImpl: turn('unused') }), (error) => error.code === 'MISSING_RULE_INPUTS');
  assert.equal(bodies.length, 0);
});

test('non-refusal errors propagate, disabled fallback stays off, and bad mechanisms are usage errors', async () => {
  const api = { async createSession() { throw new RequestError('BAD_REQUEST', 'invalid api key'); } };
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES }), /invalid api key/);
  const refused = { async createSession() { throw new RequestError('BAD_REQUEST', 'agent mode primary required'); } };
  await assert.rejects(dispatchSubagent({ api: refused, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, allowFallback: false }), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(dispatchSubagent({ api, hub: {}, member, prompt: 'p', parentSessionID: 'ses_parent', rules: RULES, mechanism: 'magic-value-beyond-preview' }), (error) => error.code === 'INVALID_MECHANISM' && error.exitCode === 2 && error.message.includes('magic-value-…') && !error.message.includes('beyond'));
});

for (const mechanism of SUBAGENT_MECHANISMS) {
  for (const trigger of ['isCancelled', 'signal']) {
    test(`member cancelled during createSession never prompts (${mechanism}, ${trigger})`, async () => {
      const { api, hub } = memoryV2();
      const create = api.createSession.bind(api);
      const controller = new AbortController();
      let cancelled = false;
      let turnCalls = 0;
      const published = [];
      const interrupted = [];
      api.createSession = async (body) => {
        const session = await create(body);
        if (trigger === 'signal') controller.abort(); else cancelled = true;
        return session;
      };
      api.interrupt = async (id) => { interrupted.push(id); return true; };
      const result = await dispatchSubagent({ api, hub, member, prompt: 'find x', parentSessionID: 'ses_parent', rules: RULES, ruleInputs,
        mechanism, isCancelled: () => cancelled, signal: controller.signal, onSession: async (id) => { published.push(id); },
        runTurnImpl: async ({ request }) => {
          turnCalls++;
          await api.prompt(request.sessionID, { text: 'must not be sent' });
          return { status: 'completed', sessionID: request.sessionID, finalText: 'unexpected' };
        } });
      assert.equal(api.promptCalls.length, 0);
      assert.equal(turnCalls, 0);
      assert.deepEqual(published, ['ses_mem1']);
      assert.deepEqual(interrupted, ['ses_mem1']);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.errorType, 'Cancelled');
      assert.equal(result.sessionID, 'ses_mem1');
      assert.equal(result.mechanism, mechanism);
      assert.equal(result.toolsRan, false);
    });
  }

  test(`dispatch forwards cancellation checks and signal to the turn (${mechanism})`, async () => {
    const { api, hub } = memoryV2();
    const controller = new AbortController();
    const isCancelled = () => false;
    await dispatchSubagent({ api, hub, member, rules: RULES, ruleInputs, mechanism, isCancelled, signal: controller.signal,
      runTurnImpl: async (args) => {
        assert.equal(args.isCancelled, isCancelled);
        assert.equal(args.signal, controller.signal);
        return turn('ok')(args);
      } });
  });
}
