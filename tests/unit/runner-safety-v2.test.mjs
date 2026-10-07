// Regression tests for the runner safety paths (callback failure, cancellation before prompt, retry cap,
// server loss, rejected prompt, timeout) over the OpenCode V2 contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { memoryV2 } from './_memory-v2.mjs';

const DENY_ALL = [{ action: '*', resource: '*', effect: 'deny' }];
const request = (over = {}) => ({ model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'hi' }], newSession: { title: 'OPC: t', permission: DENY_ALL }, ...over });
const interrupts = (api) => api.calls.filter(([name]) => name === 'interrupt').map(([, id]) => id);

// Records interrupts and, unless told otherwise, makes the session idle right after the call.
function stubInterrupt(api, { result = true, idle = true } = {}) {
  api.interrupt = async (id) => {
    api.calls.push(['interrupt', id]);
    if (idle) api.sessionStatus = async () => ({});
    return result;
  };
}

// Counts the sessions the runner keeps tracked in the hub, to prove the turn cleans up after itself.
function trackedSessions(hub) {
  const tracked = new Set();
  const track = hub.track.bind(hub);
  hub.track = (id, handler) => {
    tracked.add(id);
    const untrack = track(id, handler);
    return () => { tracked.delete(id); untrack(); };
  };
  return tracked;
}

test('C2: failed session persistence interrupts before sending the prompt', async () => {
  const { api, hub } = memoryV2();
  stubInterrupt(api);
  const result = await runTurn({ api, hub, request: request({ idleWaitMs: 50 }), onSession: async () => { throw new Error('storage failed'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorType, 'CallbackFailed');
  assert.equal(result.errorCode, 'CALLBACK_FAILED');
  assert.equal(result.abortConfirmed, true);
  assert.deepEqual(api.promptCalls, []);
  assert.deepEqual(interrupts(api), ['ses_mem1']);
});

for (const stage of ['createSession', 'onSession']) {
  for (const trigger of ['isCancelled', 'signal']) {
    for (const interruptMode of ['ok', 'server-down']) {
      test(`F4b fix2: cancellation during ${stage} via ${trigger} prevents prompting (${interruptMode})`, async () => {
        const { api, hub } = memoryV2();
        const tracked = trackedSessions(hub);
        let entered, release;
        const started = new Promise((resolve) => { entered = resolve; });
        const blocked = new Promise((resolve) => { release = resolve; });
        const pause = async () => { entered(); await blocked; };
        if (stage === 'createSession') {
          const create = api.createSession;
          api.createSession = async function (body) { await pause(); return create.call(this, body); };
        }
        if (interruptMode === 'server-down') api.interrupt = async (id) => { api.calls.push(['interrupt', id]); throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
        else stubInterrupt(api);
        const controller = new AbortController();
        let cancelled = false;
        const running = runTurn({
          api, hub, request: request(), isCancelled: () => cancelled, signal: controller.signal,
          onSession: stage === 'onSession' ? pause : async () => {},
        });
        await started;
        if (trigger === 'signal') controller.abort(); else cancelled = true;
        release();
        const result = await running;
        assert.deepEqual(api.promptCalls, []);
        assert.deepEqual(interrupts(api), ['ses_mem1']);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.errorType, 'Cancelled');
        assert.equal(result.errorCode, 'cancelled');
        assert.equal(result.toolsRan, false);
        assert.deepEqual([...tracked], []);
      });
    }
  }
}

test('already aborted signal cancels before sending the prompt', async () => {
  const { api, hub } = memoryV2();
  stubInterrupt(api);
  const controller = new AbortController();
  controller.abort();
  const result = await runTurn({ api, hub, request: request(), signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(api.promptCalls, []);
  assert.deepEqual(interrupts(api), ['ses_mem1']);
});

for (const mode of ['false', 'throws', 'busy', 'delayed-idle']) {
  test(`F4a C1: retry cap requires a confirmed interrupt (${mode})`, async () => {
    const { api, hub, emit } = memoryV2();
    let idleObserved = false;
    api.interrupt = async (id) => {
      api.calls.push(['interrupt', id]);
      if (mode === 'throws') throw new Error('interrupt unavailable');
      if (mode === 'delayed-idle') setTimeout(() => { api.sessionStatus = async () => ({}); idleObserved = true; }, 10);
      return mode !== 'false';
    };
    const pending = runTurn({ api, hub, request: request({ fallbackCfg: { maxProviderRetries: 3 }, timeoutMs: 2000, idleWaitMs: mode === 'delayed-idle' ? 350 : 20 }) });
    const sessionID = await api.created;
    await api.promptSettled;
    api.messagesFor(sessionID, [{ id: api.lastPromptId(), type: 'user' }]);
    emit({ type: 'session.retry.scheduled', data: { sessionID, attempt: 4, at: Date.now() + 1000, error: { type: 'provider.transport', message: 'retry' } } });
    const result = await pending;
    assert.equal(result.status, 'failed');
    if (mode === 'delayed-idle') {
      assert.equal(result.errorType, 'RetryCapExceeded');
      assert.equal(result.errorCode, 'retry_cap');
      assert.equal(result.errorClass, 'recoverable');
      assert.equal(idleObserved, true);
    } else {
      assert.equal(result.errorType, 'AbortUnconfirmed');
      assert.equal(result.errorCode, 'ABORT_UNCONFIRMED');
      assert.equal(result.errorClass, 'fatal');
    }
    assert.deepEqual(interrupts(api), [sessionID]);
  });
}

test('SERVER_DOWN during session creation is returned as server_lost', async () => {
  const { api, hub } = memoryV2({ createFailsOnce: new ConnectionError('SERVER_DOWN', 'connection refused') });
  const result = await runTurn({ api, hub, request: request() });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'server_lost');
  assert.equal(result.sessionID, null);
  assert.deepEqual(api.promptCalls, []);
});

test('SERVER_DOWN during resume permission patch is returned as server_lost', async () => {
  const { api, hub } = memoryV2();
  api.createdBody = { model: { providerID: 'p', id: 'm' }, agent: 'build', permissions: [] };
  api.setPermissions = async () => { throw new ConnectionError('SERVER_DOWN', 'connection refused'); };
  const result = await runTurn({ api, hub, request: request({ newSession: undefined, sessionID: 'ses_old', patchPermission: DENY_ALL }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'server_lost');
  assert.equal(result.sessionID, 'ses_old');
  assert.deepEqual(api.promptCalls, []);
});

test('400 on POST /api/session/:id/prompt is a fatal BadRequest', async () => {
  const { api, hub } = memoryV2();
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    seen.push(`${init.method} ${pathname}`);
    return new Response(JSON.stringify({ name: 'BadRequest', data: { message: 'invalid body' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  api.prompt = createApi(createClient({ baseUrl: 'http://x', password: 'pw', fetchImpl })).prompt;
  stubInterrupt(api);
  const result = await runTurn({ api, hub, request: request() });
  assert.deepEqual(seen, ['POST /api/session/ses_mem1/prompt']);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorType, 'BadRequest');
  assert.equal(result.errorCode, 'bad_request');
  assert.equal(result.errorClass, 'fatal');
});

test('turn timeout interrupts the session and is recoverable', async () => {
  const { api, hub } = memoryV2();
  stubInterrupt(api);
  const result = await runTurn({ api, hub, request: request({ timeoutMs: 100, idleWaitMs: 50 }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorType, 'Timeout');
  assert.equal(result.errorCode, 'turn_timeout');
  assert.equal(result.errorClass, 'recoverable');
  assert.deepEqual(interrupts(api), ['ses_mem1']);
});
