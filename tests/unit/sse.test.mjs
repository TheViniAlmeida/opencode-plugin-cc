import assert from 'node:assert/strict';
import test from 'node:test';

import { createSSEParser, eventSessionID } from '../../plugins/opc/scripts/lib/sse.mjs';

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

test('eventSessionID finds the session in properties, info or part', () => {
  assert.equal(eventSessionID({ properties: { sessionID: 'ses_a' } }), 'ses_a');
  assert.equal(eventSessionID({ properties: { info: { sessionID: 'ses_b' } } }), 'ses_b');
  assert.equal(eventSessionID({ properties: { part: { sessionID: 'ses_c' } } }), 'ses_c');
  assert.equal(eventSessionID({ type: 'server.heartbeat', properties: {} }), null);
  assert.equal(eventSessionID(null), null);
});
