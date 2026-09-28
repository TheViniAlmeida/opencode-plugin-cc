import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { renderReviewJob } from '../../plugins/opc/scripts/lib/render.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import reviewDroppedEvents from '../fixtures/scenarios/review-dropped-events.mjs';
import reviewOk, { REVIEW_OK_STRUCTURED } from '../fixtures/scenarios/review-ok.mjs';
import stopAllow from '../fixtures/scenarios/stop-allow.mjs';
import { turnJobRequest } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';

const valid = { verdict: 'approve', summary: 'Tudo certo.', findings: [], next_steps: [] };
function fixture({ scenario = {}, reconnect = false } = {}) {
  const listeners = new Set(), reconnects = new Set(), calls = [];
  let disconnected = false;
  const fake = { state: {}, scenario, persist() {}, emit(event) {
    if (reconnect && event.type === 'message.updated' && !event.properties.info.time.completed) {
      for (const fn of listeners) fn(structuredClone(event));
      disconnected = true;
      return;
    }
    if (disconnected) {
      if (event.type === 'session.idle') { disconnected = false; for (const fn of reconnects) fn(); }
      return;
    }
    for (const fn of listeners) fn(structuredClone(event));
  } };
  const routes = installSessionApi(fake);
  const handle = async (method, route, body, options) => {
    calls.push([method, route]);
    const response = await routes.handle(method, route, new URLSearchParams(options?.query), body);
    if (response.status >= 400) throw new RequestError(response.status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', 'requisição recusada', { details: { body: response.body } });
    return response.body;
  };
  const api = createApi({ get: (route, options) => handle('GET', route, undefined, options), post: (route, body) => handle('POST', route, body), patch: (route, body) => handle('PATCH', route, body) });
  const hub = { async start() {}, stop() {}, track(_id, fn) { listeners.add(fn); return () => listeners.delete(fn); }, onReconnect(fn) { reconnects.add(fn); return () => reconnects.delete(fn); } };
  return { api, hub, calls, fake, routes };
}
const request = { kind: 'review', model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'revise' }], format: { type: 'json_schema', schema: {} }, timeoutMs: 1000, statusPollMs: 500, idleWaitMs: 10 };

for (const reconnect of [false, true]) {
  test(`format list bug: completion and result rendering${reconnect ? ' after SSE reconnect' : ''}`, async () => {
    const { api, hub, fake, routes, calls } = fixture({ reconnect, scenario: { formatListError: true, onPromptAsync: (f, id) => f.emitTurn(id, { structured: valid, delayMs: 1 }) } });
    const output = await runTurn({ api, hub, request });
    const list = routes.handle('GET', `/session/${output.sessionID}/message`, new URLSearchParams());
    assert.equal(list.status, 400, 'fake must reproduce OpenCode 1.18.32');
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.structured, valid);
    assert.ok(calls.some(([, route]) => /\/message\/msg/.test(route)));
    assert.match(renderReviewJob({ kind: 'review', status: output.status, result: output }), /Veredito: approve/);
    assert.equal(fake.state.aborts.length, 0);
  });
}

for (const [name, text] of [
  ['whole', `  ${JSON.stringify(valid)}  `],
  ['last json fence', `texto\n\`\`\`json\n{}\n\`\`\`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nfim`],
  ['last balanced object', `markup {} <tool_call>${JSON.stringify({ ...valid, summary: 'Chaves { e } e "aspas".' })}</tool_call>`],
]) {
  test(`review accepts valid text JSON from ${name}`, async () => {
    const { api, hub } = fixture({ scenario: { onPromptAsync: (f, id) => f.emitTurn(id, { text, delayMs: 1 }) } });
    const output = await runTurn({ api, hub, request });
    assert.equal(output.status, 'completed');
    assert.equal(output.structured?.verdict, 'approve');
    assert.equal(output.structuredSource, 'text');
  });
}

test('invalid text JSON preserves degraded review path', async () => {
  const { api, hub } = fixture({ scenario: { onPromptAsync: (f, id) => f.emitTurn(id, { text: '{"verdict":"anything"}', delayMs: 1 }) } });
  const output = await runTurn({ api, hub, request });
  assert.equal(output.structured, null);
  assert.match(renderReviewJob({ kind: 'review', status: output.status, result: output }), /não retornou uma saída estruturada válida/);
});

test('tool output records tool provenance', async () => {
  const { api, hub } = fixture({ scenario: { onPromptAsync: (f, id) => f.emitTurn(id, { structured: valid, delayMs: 1 }) } });
  assert.equal((await runTurn({ api, hub, request })).structuredSource, 'tool');
});

test('unformatted resumed turn falls back once for a poisoned session', async () => {
  const { api, hub, fake, calls } = fixture({ scenario: { formatListError: true } });
  const session = fake.createSession();
  fake.state.messages[session.id].push({ info: { id: 'msg_old', role: 'user', format: request.format }, parts: [] });
  const output = await runTurn({ api, hub, request: { ...request, format: undefined, sessionID: session.id } });
  assert.equal(output.status, 'completed');
  assert.equal(calls.filter(([, route]) => route === `/session/${session.id}/message`).length, 1);
});

test('per-message helper retries only the known schema-list failure and remembers it', async () => {
  const { readSessionMessages, rememberMessage } = await import('../../plugins/opc/scripts/lib/session-messages.mjs');
  let lists = 0;
  const api = { messages: async () => { lists++; throw new RequestError('BAD_REQUEST', 'recusado', { details: { body: 'Expected OutputFormatJsonSchema' } }); }, message: async (_sid, id) => ({ info: { id } }) };
  rememberMessage(api, 'ses_test', 'msg_test');
  assert.equal((await readSessionMessages(api, 'ses_test'))[0].info.id, 'msg_test');
  await readSessionMessages(api, 'ses_test');
  assert.equal(lists, 1);
  const unrelated = new RequestError('BAD_REQUEST', 'outro erro', { details: { body: 'OtherSchema' } });
  api.messages = async () => { throw unrelated; };
  await assert.rejects(readSessionMessages(api, 'ses_other'), (err) => err === unrelated);
});

test('unformatted turns keep list reads primary', async () => {
  const { api, hub, calls } = fixture();
  await runTurn({ api, hub, request: { ...request, format: undefined } });
  assert.ok(calls.some(([, route]) => /\/message$/.test(route)));
});

test('message part with parent info can recover an assistant id without message.updated', async () => {
  const { api, hub, fake } = fixture();
  const emit = fake.emit.bind(fake);
  fake.emit = (event) => {
    if (event.type === 'message.updated') return;
    if (event.type === 'message.part.updated') event.properties.info = fake.state.messages[event.properties.sessionID].find((m) => m.info.id === event.properties.part.messageID).info;
    emit(event);
  };
  assert.equal((await runTurn({ api, hub, request })).status, 'completed');
});

test('message part id can recover parent info through the individual route', async () => {
  const { api, hub, fake } = fixture();
  const emit = fake.emit.bind(fake);
  fake.emit = (event) => { if (event.type !== 'message.updated') emit(event); };
  assert.equal((await runTurn({ api, hub, request })).status, 'completed');
});

test('valid text never clears any turn error', async () => {
  for (const errorName of ['StructuredOutputError', 'ProviderAuthError']) {
    const { api, hub } = fixture({ scenario: { onPromptAsync: (f, id) => f.emitTurn(id, { text: JSON.stringify(valid), error: { name: errorName, data: { message: 'falha' } }, delayMs: 1 }) } });
    const output = await runTurn({ api, hub, request });
    assert.equal(output.status, 'failed');
    assert.equal(output.error.name, errorName);
    assert.equal(output.structured, null);
    assert.equal(output.structuredSource, null);
  }
});

test('worker persists recovered text provenance and result command renders without a list read', async (t) => {
  const { makeTempDir, trackTempDir } = await import('../helpers.mjs');
  const { createJob, readJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
  const { run: worker } = await import('../../plugins/opc/scripts/commands/task-worker.mjs');
  const { run: result } = await import('../../plugins/opc/scripts/commands/result.mjs');
  const { run: status } = await import('../../plugins/opc/scripts/commands/status.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const secret = ['ghp', 'x'.repeat(32)].join('_');
  const stateDir = trackTempDir(t, makeTempDir('opc-fallback-worker-'));
  const { api, hub, calls } = fixture({ reconnect: true, scenario: { formatListError: true, onPromptAsync: (f, id) => f.emitTurn(id, { text: JSON.stringify({ ...valid, summary: secret }), delayMs: 1 }) } });
  const job = await createJob(stateDir, { kind: 'review', request });
  const ctx = { stateDir, workspaceRoot: stateDir };
  assert.equal(await worker(ctx, ['--job-id', job.id], {
    ensureServer: async () => ({ url: 'http://unused.invalid' }), createApi: () => api, createHub: () => hub, scheduleExit() {},
  }), 0);
  const stored = readJob(stateDir, job.id);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.result.structuredSource, 'text');
  assert.equal(stored.result.structured.summary, '***');
  assert.ok(stored.assistantMessageIDs.length > 0);
  for (const suffix of ['json', 'log']) assert.equal(readFileSync(join(stateDir, 'jobs', `${job.id}.${suffix}`), 'utf8').includes(secret), false);
  let rendered;
  const count = calls.length;
  assert.equal(await result({ ...ctx, json: (value) => { rendered = value; } }, [job.id, '--json']), 0);
  assert.match(rendered.rendered, /Veredito: approve/);
  assert.equal(JSON.stringify(rendered).includes(secret), false);
  await status({ ...ctx, json: (value) => { rendered = value; } }, [job.id, '--json']);
  assert.equal(JSON.stringify(rendered).includes(secret), false);
  assert.equal(calls.length, count, 'result/status read safe local metadata, not API lists');
});

for (const toolMode of [false, true]) {
  test(`lost SSE events: ${toolMode ? 'tool mode fails after idle grace' : 'text mode recovers through list'}`, async () => {
    const { api, hub, fake } = fixture({ scenario: {
      ...reviewDroppedEvents,
      onPromptAsync: (f, id) => f.emitTurn(id, { text: JSON.stringify(valid), delayMs: 1 }),
    } });
    const started = performance.now();
    const output = await runTurn({ api, hub, request: { ...request, format: toolMode ? request.format : undefined, timeoutMs: 15_000, statusPollMs: 20 } });
    if (toolMode) {
      assert.equal(output.errorCode, 'NO_ASSISTANT_MESSAGE');
      assert.deepEqual(output.assistantMessageIDs, []);
      assert.ok(performance.now() - started >= 10_000, 'must allow the full idle grace');
      assert.ok(performance.now() - started < 14_000, 'must not wait for the global timeout');
    } else {
      assert.equal(output.status, 'completed');
      assert.deepEqual(output.structured, valid);
      assert.equal(output.structuredSource, 'text');
    }
    assert.equal(fake.state.aborts.length, 0);
  });
}

for (const kind of ['review', 'adversarial-review', 'stop-gate']) {
  test(`default ${kind} uses normal list reads and the text contract with the fake`, async () => {
    const { api, hub, calls, fake } = fixture({ scenario: kind === 'stop-gate' ? stopAllow : reviewOk });
    const input = turnJobRequest({ kind, profile: 'read-only', prompt: 'Revise.', model: request.model, modelFull: 'p/m', title: 'OPC: revisão', config: DEFAULT_CONFIG, timeoutMs: 1000 });
    const output = await runTurn({ api, hub, request: input });
    assert.equal(output.status, 'completed');
    const user = fake.state.messages[output.sessionID].find((m) => m.info.role === 'user');
    assert.equal(Object.hasOwn(user.info, 'format'), false);
    assert.ok(calls.some(([, route]) => /\/message$/.test(route)));
    if (kind === 'stop-gate') assert.match(output.finalText, /^ALLOW:/);
    else {
      assert.deepEqual(output.structured, REVIEW_OK_STRUCTURED);
      assert.equal(output.structuredSource, 'text');
    }
  });
}

test('a session.error without an error in the message also prevents text extraction', async () => {
  const error = { name: 'StructuredOutputError', data: { message: 'Falha na saída.' } };
  const { api, hub, fake } = fixture({ scenario: { onPromptAsync: (f, id) => f.emitTurn(id, { text: JSON.stringify(valid), delayMs: 1 }) } });
  const emit = fake.emit.bind(fake);
  fake.emit = (event) => {
    if (event.type === 'session.idle') emit({ type: 'session.error', properties: { sessionID: event.properties.sessionID, error } });
    if (event.type !== 'session.status') emit(event);
  };
  const output = await runTurn({ api, hub, request });
  assert.equal(output.status, 'failed');
  assert.equal(output.error.name, error.name);
  assert.equal(output.structured, null);
});

test('tool idle grace rechecks status and waits through renewed activity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { api, hub, fake } = fixture({ scenario: { dropSseEvents: true, onPromptAsync() {} } });
  let settled = false;
  const pending = runTurn({ api, hub, request: { ...request, timeoutMs: 60_000, statusPollMs: 100 } }).then((output) => { settled = true; return output; });
  await flush();
  t.mock.timers.tick(100);
  await flush();
  const [sessionID] = Object.keys(fake.state.sessions);
  fake.state.statuses[sessionID] = { type: 'busy' };
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(settled, false, 'busy status at the recheck cancels the idle grace');
  delete fake.state.statuses[sessionID];
  t.mock.timers.tick(100);
  await flush();
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(settled, false, 'a new idle period gets a full grace');
  t.mock.timers.tick(1);
  await flush();
  assert.equal((await pending).errorCode, 'NO_ASSISTANT_MESSAGE');
  assert.equal(fake.state.aborts.length, 0);
});

test('an idle grace recheck error does not leave the turn waiting for its global timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { api, hub } = fixture({ scenario: { dropSseEvents: true, onPromptAsync() {} } });
  const status = api.sessionStatus;
  let failRecheck = false;
  api.sessionStatus = async () => {
    if (failRecheck) throw new Error('Falha transitória de consulta.');
    return status();
  };
  let output;
  const pending = runTurn({ api, hub, request: { ...request, timeoutMs: 60_000, statusPollMs: 100 } }).then((value) => { output = value; });
  await flush();
  t.mock.timers.tick(100);
  await flush();
  failRecheck = true;
  t.mock.timers.tick(10_000);
  await flush();
  failRecheck = false;
  t.mock.timers.tick(100);
  await flush();
  assert.equal(output?.errorCode, 'NO_ASSISTANT_MESSAGE');
  await pending;
});

test('a later unformatted turn of a list-broken session also stops after the idle grace', async () => {
  const { usePerMessageReads } = await import('../../plugins/opc/scripts/lib/session-messages.mjs');
  const { api, hub, fake } = fixture({ scenario: {
    ...reviewDroppedEvents,
    onPromptAsync: (f, id) => f.emitTurn(id, { text: JSON.stringify(valid), delayMs: 1 }),
  } });
  const session = await api.createSession({ title: 'OPC: resume after a formatted turn' });
  // The OpenCode list bug already hit this session (an earlier formatted turn): reads go by id only.
  usePerMessageReads(api, session.id);
  const started = performance.now();
  const output = await runTurn({ api, hub, request: { ...request, sessionID: session.id, format: undefined, timeoutMs: 15_000, statusPollMs: 20 } });
  assert.equal(output.errorCode, 'NO_ASSISTANT_MESSAGE');
  assert.ok(performance.now() - started < 14_000, 'must not wait for the global timeout');
  assert.equal(fake.state.aborts.length, 0);
});
