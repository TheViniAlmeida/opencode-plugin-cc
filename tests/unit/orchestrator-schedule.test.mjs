import test from 'node:test';
import assert from 'node:assert/strict';
import { pickReady, propagateDependencyFailures } from '../../plugins/opc/scripts/lib/orchestrator.mjs';

const s = (id, kind = 'ask', dependsOn = []) => ({ id, kind, dependsOn });
const statesOf = (subtasks, overrides = {}) =>
  new Map(subtasks.map((x) => [x.id, { status: overrides[x.id] ?? 'pending' }]));

test('independent read subtasks start in parallel up to maxParallel, in plan order', () => {
  const subs = [s('a'), s('b'), s('c'), s('d'), s('e')];
  assert.deepEqual(pickReady(subs, statesOf(subs), { maxParallel: 4 }).map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(pickReady(subs, statesOf(subs, { a: 'running', b: 'running' }), { maxParallel: 3 }).map((x) => x.id), ['c']);
});

test('a subtask waits until every dependency completed', () => {
  const subs = [s('a'), s('b'), s('c', 'review', ['a', 'b'])];
  assert.deepEqual(pickReady(subs, statesOf(subs, { a: 'completed', b: 'running' }), { maxParallel: 4 }).map((x) => x.id), []);
  assert.deepEqual(pickReady(subs, statesOf(subs, { a: 'completed', b: 'completed' }), { maxParallel: 4 }).map((x) => x.id), ['c']);
});

test('write subtasks never run next to each other; reads keep flowing', () => {
  const subs = [s('w1', 'task'), s('w2', 'task'), s('r1'), s('r2')];
  assert.deepEqual(pickReady(subs, statesOf(subs), { maxParallel: 4 }).map((x) => x.id), ['w1', 'r1', 'r2']);
  assert.deepEqual(pickReady(subs, statesOf(subs, { w1: 'running', r1: 'completed', r2: 'completed' }), { maxParallel: 4 }).map((x) => x.id), []);
  assert.deepEqual(pickReady(subs, statesOf(subs, { w1: 'completed', r1: 'completed', r2: 'completed' }), { maxParallel: 4 }).map((x) => x.id), ['w2']);
});

test('maxParallel 1 serializes everything', () => {
  const subs = [s('a'), s('b')];
  assert.deepEqual(pickReady(subs, statesOf(subs), { maxParallel: 1 }).map((x) => x.id), ['a']);
});

test('failure propagates transitively to dependents only', () => {
  const subs = [s('a'), s('b', 'ask', ['a']), s('c', 'ask', ['b']), s('d')];
  const states = statesOf(subs, { a: 'failed' });
  assert.deepEqual(propagateDependencyFailures(subs, states), ['b', 'c']);
  assert.deepEqual(states.get('b'), { status: 'cancelled', errorCode: 'dependency_failed', errorMessage: 'dependência "a" falhou' });
  assert.deepEqual(states.get('c'), { status: 'cancelled', errorCode: 'dependency_failed', errorMessage: 'dependência "b" cancelada' });
  assert.equal(states.get('d').status, 'pending');
  assert.deepEqual(propagateDependencyFailures(subs, states), []);
});
