import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { readSessionMessages } from '../../plugins/opc/scripts/lib/session-messages.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const valid = { verdict: 'approve', summary: 'Tudo certo.', findings: [], next_steps: [] };
const request = () => ({
  kind: 'review', model: { providerID: 'p', modelID: 'm' },
  newSession: { title: 'OPC: revisão', permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
  parts: [{ type: 'text', text: 'Review' }], timeoutMs: 1000, statusPollMs: 20,
});

function fixture({ text = '', error = null, deliverEvent = true } = {}) {
  let handler, reconnect;
  let active = true;
  let list = [];
  const calls = [];
  const api = {
    calls,
    async createSession(body) { calls.push(['createSession', body]); return { id: 'ses_review' }; },
    async prompt(_id, body) {
      calls.push(['prompt', body]);
      list = [
        { id: body.id, type: 'user', text: body.text },
        { id: 'msg_assistant', type: 'assistant', content: [{ type: 'text', text }], ...(error ? { error } : {}) },
        { id: 'msg_idle', type: 'idle', outcome: error ? 'failed' : 'succeeded' },
      ];
      active = false;
      setImmediate(() => {
        if (deliverEvent) handler({ type: error ? 'session.execution.failed' : 'session.execution.succeeded', data: { sessionID: 'ses_review', ...(error ? { error } : {}) } });
        else reconnect();
      });
    },
    async sessionStatus() { return active ? { ses_review: { type: 'busy' } } : {}; },
    async messages() { calls.push(['messages']); return list; },
    async children() { return []; },
    async listPermissions() { return []; },
    async listQuestions() { return []; },
    async diff() { return []; },
  };
  const hub = { track(_id, fn) { handler = fn; return () => {}; }, onReconnect(fn) { reconnect = fn; return () => {}; } };
  return { api, hub, calls };
}

for (const [name, text] of [
  ['whole', `  ${JSON.stringify(valid)}  `],
  ['last JSON fence', `texto\n\`\`\`json\n{}\n\`\`\`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nfim`],
  ['last balanced object', `markup {} <tool_call>${JSON.stringify({ ...valid, summary: 'Chaves { e } e "aspas".' })}</tool_call>`],
]) {
  test(`V2 review accepts valid text JSON from ${name}`, async () => {
    const { api, hub, calls } = fixture({ text });
    const output = await runTurn({ api, hub, request: request() });
    assert.equal(output.status, 'completed');
    assert.equal(output.structured?.verdict, 'approve');
    assert.equal(output.structuredSource, 'text');
    assert.equal(Object.hasOwn(calls.find(([kind]) => kind === 'prompt')[1], 'format'), false);
  });
}

test('V2 invalid review JSON preserves the degraded path', async () => {
  const { api, hub } = fixture({ text: '{"verdict":"anything"}' });
  const output = await runTurn({ api, hub, request: request() });
  assert.equal(output.status, 'completed');
  assert.equal(output.structured, null);
  assert.equal(output.structuredSource, null);
});

test('V2 execution error prevents text JSON extraction', async () => {
  const { api, hub } = fixture({ text: JSON.stringify(valid), error: { type: 'provider.no-route', message: 'private/model' } });
  const output = await runTurn({ api, hub, request: request() });
  assert.equal(output.status, 'failed');
  assert.equal(output.errorType, 'provider.no-route');
  assert.equal(output.structured, null);
});

test('V2 review recovers after lost completion event', async () => {
  const { api, hub } = fixture({ text: JSON.stringify(valid), deliverEvent: false });
  const output = await runTurn({ api, hub, request: request() });
  assert.equal(output.status, 'completed');
  assert.equal(output.structuredSource, 'text');
  assert.ok(output.assistantMessageIDs.includes('msg_assistant'));
});

test('V2 message reader lists ascending messages and propagates errors', async () => {
  const sample = loadContractSample('messages-turn.json').data;
  const calls = [];
  const api = { messages: async (id, options) => { calls.push([id, options]); return sample; } };
  assert.deepEqual(await readSessionMessages(api, 'ses_test', { limit: 20 }), sample);
  assert.deepEqual(calls, [['ses_test', { limit: 20 }]]);
  const failure = new Error('falha de leitura');
  api.messages = async () => { throw failure; };
  await assert.rejects(readSessionMessages(api, 'ses_test'), (error) => error === failure);
});
