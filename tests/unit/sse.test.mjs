import assert from 'node:assert/strict';
import test from 'node:test';

import { EventHub, createSSEParser, eventSessionID } from '../../plugins/opc/scripts/lib/sse.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const client = { buildUrl: () => 'http://opc.test/event', authHeaders: () => ({}) };

function responseWithFrames(...frames) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => index < frames.length
          ? { done: false, value: new TextEncoder().encode(frames[index++]) }
          : new Promise(() => {}),
      }),
    },
  };
}

test('parser returns JSON of each data frame, across chunk boundaries', () => {
  const p = createSSEParser();
  assert.deepEqual(p.push('data: {"type":"server.connected","properties":{}}\n\nda'), [{ type: 'server.connected', properties: {} }]);
  assert.deepEqual(p.push('ta: {"type":"server.heartbeat"}\n'), []);
  assert.deepEqual(p.push('\n'), [{ type: 'server.heartbeat' }]);
});

test('parser ignores comments, non-data fields and invalid JSON; handles CRLF and multi-line data', () => {
  const p = createSSEParser();
  const events = p.push(': keep-alive\n\nevent: x\nid: 1\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: not json\n\ndata:{"b":2}\n\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test('parser normalizes CRLF split across chunk boundaries', () => {
  const p = createSSEParser();
  assert.deepEqual(p.push('data: {"type":"a"}\r'), []);
  assert.deepEqual(p.push('\n\r'), []);
  assert.deepEqual(p.push('\n'), [{ type: 'a' }]);
});

test('eventSessionID finds the session in properties, info or part', () => {
  assert.equal(eventSessionID({ properties: { sessionID: 'ses_a' } }), 'ses_a');
  assert.equal(eventSessionID({ properties: { info: { sessionID: 'ses_b' } } }), 'ses_b');
  assert.equal(eventSessionID({ properties: { part: { sessionID: 'ses_c' } } }), 'ses_c');
  assert.equal(eventSessionID({ type: 'server.heartbeat', properties: {} }), null);
  assert.equal(eventSessionID(null), null);
});

test('server.instance.disposed as the first frame makes start reconnect before opening', async () => {
  let fetchCount = 0;
  let releaseSecond;
  const secondHeaders = new Promise((resolve) => { releaseSecond = resolve; });
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1],
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return responseWithFrames('data: {"type":"server.instance.disposed"}\n\n');
      await secondHeaders;
      return responseWithFrames('data: {"type":"server.connected"}\n\n');
    },
  });
  let settled = false;
  const started = hub.start().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCount, 2);
  assert.equal(settled, false);
  releaseSecond();
  await started;
  hub.stop();
});

test('a fetch that never returns headers times out during initial start', async () => {
  const hub = new EventHub({
    client,
    livenessMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  await assert.rejects(hub.start(), (err) => err.code === 'TIMEOUT');
  assert.equal(hub.state, 'idle');
});

test('a fetch that never returns headers counts as a failed reconnect attempt', async () => {
  let fetchCount = 0;
  let downError;
  const hub = new EventHub({
    client,
    livenessMs: 10,
    backoffMs: [1],
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount > 1) return new Promise(() => {});
      let first = true;
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: async () => {
          if (first) {
            first = false;
            return { done: false, value: new TextEncoder().encode('data: {"type":"server.connected"}\n\n') };
          }
          return { done: true };
        } }) },
      };
    },
  });
  hub.onDown((err) => { downError = err; });
  await hub.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fetchCount, 2);
  assert.equal(downError?.code, 'SERVER_DOWN');
  assert.equal(hub.state, 'down');
});

test('stop while connecting rejects start and does not reconnect', async () => {
  let fetchCount = 0;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1],
    fetchImpl: () => {
      fetchCount += 1;
      return new Promise(() => {});
    },
  });
  const started = hub.start();
  await new Promise((resolve) => setImmediate(resolve));
  hub.stop();
  await assert.rejects(started, /stopped/i);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.state, 'stopped');
  assert.equal(fetchCount, 1);
});

test('stop while waiting for the first frame rejects start and does not reconnect', async () => {
  let fetchCount = 0;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1],
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
    },
  });
  const started = hub.start();
  await new Promise((resolve) => setImmediate(resolve));
  hub.stop();
  await assert.rejects(started, /stopped/i);
  assert.equal(hub.state, 'stopped');
  assert.equal(fetchCount, 1);
});

test('throwing event handlers emit redacted warnings and do not stop other handlers', () => {
  const hub = new EventHub({ client });
  const seen = [];
  const warnings = [];
  const originalEmitWarning = process.emitWarning;
  registerSecret('handler-secret-123');
  process.emitWarning = (err, options) => warnings.push({ err, options });
  try {
    hub.onAny(() => { throw new Error('handler-secret-123 failed'); });
    hub.onAny((event) => seen.push(event.type));
    hub._dispatch({ type: 'server.connected' });
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  assert.deepEqual(seen, ['server.connected']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].options.type, 'OpcEventHubHandlerError');
  assert.equal(warnings[0].options.detail, 'onAny');
  assert.match(warnings[0].err.message, /\*\*\*/);
  assert.doesNotMatch(warnings[0].err.message, /handler-secret-123/);
});
