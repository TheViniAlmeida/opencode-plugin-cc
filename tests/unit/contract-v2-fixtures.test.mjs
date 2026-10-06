import assert from 'node:assert/strict';
import test from 'node:test';

import { assertShape, loadContractSample, V2_SHAPES } from '../fixtures/contract-shapes.mjs';

test('V2 contract samples match the recorded shapes', () => {
  for (const [file, shape] of Object.entries(V2_SHAPES.files)) {
    const sample = loadContractSample(file);
    if (shape) assertShape(shape, sample.data ?? sample);
  }
  const turn = loadContractSample('messages-turn.json').data;
  assert.deepEqual(turn.map((m) => m.type), ['user', 'assistant', 'assistant', 'idle']);
  for (const m of turn) assertShape(`message.${m.type}`, m);
  assert.equal(turn.at(-1).outcome, 'succeeded');
  const failed = loadContractSample('messages-failed.json').data;
  assert.deepEqual(failed.map((m) => [m.type, m.outcome ?? null]), [['user', null], ['idle', 'failed']]);
  const interrupted = loadContractSample('messages-interrupted.json').data;
  assert.equal(interrupted.at(-1).outcome, 'interrupted');
  for (const m of loadContractSample('model.json').data) assertShape('model', m);
  for (const a of loadContractSample('agent.json').data) assertShape('agent', a);
  for (const p of loadContractSample('provider.json').data) assertShape('provider', p);
});

test('V2 event samples use the envelope and the recorded types', () => {
  const events = [
    ...loadContractSample('events-turn.jsonl'),
    ...loadContractSample('events-permission.jsonl'),
    ...loadContractSample('events-form.jsonl'),
    ...loadContractSample('events-failure.jsonl'),
  ];
  for (const e of events) assertShape('event', e);
  const types = new Set(events.map((e) => e.type));
  for (const type of ['server.connected', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
    'session.execution.interrupted', 'session.retry.scheduled', 'session.tool.called', 'session.tool.success', 'session.tool.failed',
    'permission.asked', 'permission.replied', 'form.created', 'form.replied']) {
    assert.ok(types.has(type), type);
  }
  assert.ok(loadContractSample('events-form.jsonl').find((e) => e.type === 'form.created').data.form, 'form.created wraps the form');
  assert.match(loadContractSample('sse-stream.txt'), /^: heartbeat$/m);
});

test('V2 contract samples carry no operator data', () => {
  const files = [...Object.keys(V2_SHAPES.files), 'events-turn.jsonl', 'events-permission.jsonl', 'events-form.jsonl', 'events-failure.jsonl', 'sse-stream.txt'];
  for (const name of files) {
    const text = JSON.stringify(loadContractSample(name));
    assert.doesNotMatch(text, /omniroute-(?!personal)|\/home\/|\/storage\/|\/tmp\/(?!opencode\b)/i, name);
  }
});
