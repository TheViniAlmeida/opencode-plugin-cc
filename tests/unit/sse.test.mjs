import assert from 'node:assert/strict';
import test from 'node:test';

import { EventHub, createSSEParser, eventSessionID } from '../../plugins/opc/scripts/lib/sse.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';

const client = { buildUrl: () => 'http://opc.test/api/event', authHeaders: () => ({}) };

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
  assert.deepEqual(p.push('data: {"type":"server.connected","data":{}}\n\nda'), { events: [{ type: 'server.connected', data: {} }], comments: 0 });
  assert.deepEqual(p.push('ta: {"type":"session.execution.succeeded","data":{"sessionID":"ses_a"}}\n'), { events: [], comments: 0 });
  assert.deepEqual(p.push('\n'), { events: [{ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } }], comments: 0 });
});

test('parser counts heartbeat comments and parses data frames', () => {
  const parser = createSSEParser();
  const out = parser.push(': heartbeat\n\ndata: {"type":"server.connected","data":{}}\n\n: heartbeat\n\n');
  assert.equal(out.comments, 2);
  assert.deepEqual(out.events.map((e) => e.type), ['server.connected']);
});

test('parser counts each line-terminated heartbeat before a frame delimiter', () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push(': heartbeat\n'), { events: [], comments: 1 });
  assert.deepEqual(parser.push(': heartbeat\n'), { events: [], comments: 1 });
  assert.deepEqual(parser.push('\n'), { events: [], comments: 0 });
});

test('parser accepts the recorded OpenCode 2.0.22 stream', () => {
  const result = createSSEParser().push(loadContractSample('sse-stream.txt'));
  assert.ok(result.comments >= 2);
  assert.equal(result.events[0].type, 'server.connected');
  assert.equal(result.events[1].type, 'session.created');
  assert.ok(result.events[1].data.sessionID);
});

test('parser counts comments, ignores non-data fields and invalid JSON; handles CRLF and multi-line data', () => {
  const p = createSSEParser();
  const out = p.push(': keep-alive\n\nevent: x\nid: 1\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: not json\n\ndata:{"b":2}\n\n');
  assert.deepEqual(out, { events: [{ a: 1 }, { b: 2 }], comments: 1 });
});

test('parser normalizes CRLF split across chunk boundaries', () => {
  const p = createSSEParser();
  assert.deepEqual(p.push('data: {"type":"a"}\r'), { events: [], comments: 0 });
  assert.deepEqual(p.push('\n\r'), { events: [], comments: 0 });
  assert.deepEqual(p.push('\n'), { events: [{ type: 'a' }], comments: 0 });
});

test('eventSessionID reads data.sessionID from the V2 envelope', () => {
  assert.equal(eventSessionID({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } }), 'ses_a');
  assert.equal(eventSessionID({ type: 'server.connected', data: {} }), null);
  assert.equal(eventSessionID(null), null);
});

test('hub requests /api/event with client auth and directory headers', async () => {
  let request;
  const hub = new EventHub({
    client: { buildUrl: (path) => `http://opc.test${path}`, authHeaders: () => ({ authorization: 'Basic fake' }), directory: '/workspace' },
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers };
      return responseWithFrames('data: {"type":"server.connected","data":{}}\n\n');
    },
  });
  await hub.start();
  assert.equal(request.url, 'http://opc.test/api/event');
  assert.equal(request.headers.authorization, 'Basic fake');
  assert.equal(request.headers['x-opencode-directory'], '/workspace');
  hub.stop();
});

test('heartbeat comments rearm liveness without dispatching events', async () => {
  let fetchCount = 0;
  const received = [];
  const hub = new EventHub({
    client,
    livenessMs: 80,
    backoffMs: [1],
    fetchImpl: async (_url, { signal }) => {
      fetchCount += 1;
      let readCount = 0;
      return { ok: true, status: 200, body: { getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            readCount += 1;
            resolve({ done: false, value: new TextEncoder().encode(readCount === 1 ? ': heartbeat\n\n' : ': heartbeat\n') });
          }, 20);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      }) } };
    },
  });
  hub.onAny((event) => received.push(event));
  await hub.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fetchCount, 1);
  assert.equal(hub.state, 'open');
  assert.deepEqual(received, []);
  hub.stop();
});

test('hub routes complete V2 envelopes to tracked children and grandchildren', () => {
  const hub = new EventHub({ client });
  const received = [];
  hub.track('ses_root', (event) => received.push(event));
  const child = { id: 'evt_1', type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root' } };
  const grandchild = { id: 'evt_2', type: 'session.created', data: { sessionID: 'ses_grand', parentID: 'ses_child' } };
  const completed = { id: 'evt_3', type: 'session.execution.succeeded', data: { sessionID: 'ses_grand' } };
  hub._dispatch(child);
  hub._dispatch(grandchild);
  hub._dispatch(completed);
  assert.deepEqual(received, [child, grandchild, completed]);
});

test('a heartbeat comment opens the stream without server.connected', async () => {
  let fetchCount = 0;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1],
    fetchImpl: async () => {
      fetchCount += 1;
      return responseWithFrames(': heartbeat\n\n');
    },
  });
  await hub.start();
  assert.equal(hub.state, 'open');
  assert.equal(fetchCount, 1);
  hub.stop();
});

test('reconnection opens on a line-terminated comment without server.connected', async () => {
  let fetchCount = 0;
  let reconnects = 0;
  const received = [];
  let notifyReconnect;
  const reconnected = new Promise((resolve) => { notifyReconnect = resolve; });
  const hub = new EventHub({
    client,
    livenessMs: 50,
    backoffMs: [1],
    fetchImpl: async () => {
      fetchCount += 1;
      const frames = fetchCount === 1
        ? ['data: {"type":"server.connected","data":{}}\n\n']
        : [': heartbeat\n'];
      let index = 0;
      return { ok: true, status: 200, body: { getReader: () => ({
        read: async () => index < frames.length
          ? { done: false, value: new TextEncoder().encode(frames[index++]) }
          : fetchCount === 1 ? { done: true } : new Promise(() => {}),
      }) } };
    },
  });
  hub.onAny((event) => received.push(event.type));
  hub.onReconnect(() => { reconnects += 1; notifyReconnect(); });
  try {
    await hub.start();
    await Promise.race([reconnected, new Promise((resolve) => setTimeout(resolve, 100))]);
    assert.equal(fetchCount, 2);
    assert.equal(reconnects, 1);
    assert.deepEqual(received, ['server.connected']);
  } finally {
    hub.stop();
  }
});

test('stop during reconnect keeps the hub stopped', async () => {
  let fetchCount = 0;
  let secondSignal;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1],
    fetchImpl: async (_url, { signal }) => {
      fetchCount += 1;
      if (fetchCount === 1) return { ok: true, status: 200, body: { getReader: () => {
        let first = true;
        return { read: async () => {
          if (!first) return { done: true };
          first = false;
          return { done: false, value: new TextEncoder().encode(': heartbeat\n\n') };
        } };
      } } };
      secondSignal = signal;
      return new Promise(() => {});
    },
  });
  await hub.start();
  while (fetchCount < 2) await new Promise((resolve) => setImmediate(resolve));
  hub.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.state, 'stopped');
  assert.equal(fetchCount, 2);
  assert.equal(secondSignal.aborted, true);
});

test('stop during the reconnect backoff ends the wait instead of holding the process', async () => {
  let fetchCount = 0;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [60_000],
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, body: { getReader: () => {
        let first = true;
        return { read: async () => {
          if (!first) return { done: true };
          first = false;
          return { done: false, value: new TextEncoder().encode(': heartbeat\n\n') };
        } };
      } } };
    },
  });
  await hub.start();
  while (hub.state !== 'reconnecting') await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof hub._wakeBackoff, 'function', 'hub is not waiting in the backoff');
  hub.stop();
  assert.equal(hub._wakeBackoff, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.state, 'stopped');
  assert.equal(fetchCount, 1);
});

test('dropped connections abort and close their streams before reconnecting', async () => {
  const signals = [];
  let openStreams = 0;
  let maxOpenStreams = 0;
  const hub = new EventHub({
    client,
    livenessMs: 1000,
    backoffMs: [1, 1],
    fetchImpl: async (_url, { signal }) => {
      signals.push(signal);
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            openStreams += 1;
            maxOpenStreams = Math.max(maxOpenStreams, openStreams);
            let yielded = false;
            let closed = false;
            const close = () => {
              if (!closed) {
                closed = true;
                openStreams -= 1;
              }
            };
            return {
              read: async () => {
                if (yielded) return { done: true };
                yielded = true;
                return { done: false, value: new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n') };
              },
              cancel: async () => close(),
              releaseLock: close,
            };
          },
        },
      };
    },
  });
  await hub.start();
  while (signals.length < 2) await new Promise((resolve) => setImmediate(resolve));
  hub.stop();
  assert.ok(signals.length >= 2);
  assert.ok(signals.slice(0, -1).every((signal) => signal.aborted));
  assert.equal(maxOpenStreams, 1);
  assert.equal(openStreams, 0);
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
  await assert.rejects(started, /parou antes de abrir/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.state, 'stopped');
  assert.equal(fetchCount, 1);
});

test('stop immediately after start rejects as stopped without invoking fetch', async () => {
  let fetchCount = 0;
  const hub = new EventHub({
    client,
    fetchImpl: () => {
      fetchCount += 1;
      return new Promise(() => {});
    },
  });
  const started = hub.start();
  hub.stop();
  await assert.rejects(started, /parou antes de abrir/);
  assert.equal(fetchCount, 0);
  assert.equal(hub.state, 'stopped');
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
  await assert.rejects(started, /parou antes de abrir/);
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

test('handler warning redacts both error message and error name', () => {
  const hub = new EventHub({ client });
  const warnings = [];
  const originalEmitWarning = process.emitWarning;
  registerSecret('private-error-name');
  process.emitWarning = (err) => warnings.push(err);
  try {
    hub.onAny(() => {
      const err = new Error('failed');
      err.name = 'private-error-name';
      throw err;
    });
    hub._dispatch({ type: 'server.connected' });
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].name, /\*\*\*/);
  assert.doesNotMatch(warnings[0].name, /private-error-name/);
});
