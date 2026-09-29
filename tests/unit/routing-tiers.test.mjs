import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, assertTier, resolveCandidates, routingFields, attemptRequest,
  DEFAULT_BACKOFF_MS, backoffFromEnv, backoffDelay, abortableSleep,
} from '../../plugins/opc/scripts/lib/routing.mjs';

const A = { providerID: 'p', modelID: 'a', full: 'p/a', source: 'routing.tasks.ask' };
const B = { providerID: 'p', modelID: 'b', full: 'p/b', source: 'routing.tasks.ask' };

test('TIERS lists light and heavy', () => assert.deepEqual([...TIERS], ['light', 'heavy']));

test('assertTier accepts an absent tier and configured tiers', () => {
  const config = { routing: { tiers: { light: ['p/a'], heavy: ['p/b', 'p/c'] } } };
  assert.doesNotThrow(() => assertTier(undefined, config));
  assert.doesNotThrow(() => assertTier('', config));
  assert.doesNotThrow(() => assertTier('light', config));
  assert.doesNotThrow(() => assertTier('heavy', config));
});

test('assertTier rejects an unknown tier with INVALID_TIER (exit 2)', () => {
  assert.throws(() => assertTier('medium', { routing: { tiers: {} } }), (err) => err.code === 'INVALID_TIER' && err.exitCode === 2);
});

test('assertTier rejects an empty tier with EMPTY_TIER (exit 2)', () => {
  assert.throws(() => assertTier('light', { routing: { tiers: { light: [] } } }), (err) => err.code === 'EMPTY_TIER' && err.exitCode === 2);
  assert.throws(() => assertTier('heavy', { routing: {} }), (err) => err.code === 'EMPTY_TIER');
});

test('resolveCandidates validates --tier before touching the catalog', () => {
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: 'medium' }, config: { routing: { tiers: {} } }, catalog: null, opencodeConfig: null }), (err) => err.code === 'INVALID_TIER');
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: 'light' }, config: { routing: { tiers: { light: [] } } }, catalog: null, opencodeConfig: null }), (err) => err.code === 'EMPTY_TIER');
});

test('routingFields copies candidates, warnings, eligibility and context limits', () => {
  const resolution = { candidates: [{ ...A, extra: 1 }, B], warnings: ['ignorado p/x: negado'], fallbackEligible: true };
  const fields = routingFields(resolution);
  assert.deepEqual(fields.candidates, [{ ...A, contextLimit: null }, { ...B, contextLimit: null }]);
  assert.equal(fields.fallbackEligible, true);
  assert.deepEqual(fields.routingWarnings, ['ignorado p/x: negado']);
  const catalog = { byFull: new Map([['p/a', { limit: { context: 128000 } }]]) };
  assert.equal(routingFields(resolution, { catalog }).candidates[0].contextLimit, 128000);
});

test('routingFields disables fallback on resume and keeps ineligible resolutions ineligible', () => {
  const resolution = { candidates: [A, B], warnings: [], fallbackEligible: true };
  assert.equal(routingFields(resolution, { resume: true }).fallbackEligible, false);
  assert.equal(routingFields({ ...resolution, fallbackEligible: false }).fallbackEligible, false);
  assert.equal(routingFields({ candidates: [A] }).fallbackEligible, false);
});

test('attemptRequest swaps model and messageID and keeps everything else', () => {
  let n = 0;
  const base = { parts: [{ type: 'text', text: 'oi' }], newSession: { title: 'OPC: ask', permission: [] }, model: { providerID: 'p', modelID: 'a' }, messageID: 'msg0', fallbackCfg: { maxAttempts: 3 } };
  const req = attemptRequest(base, B, { messageId: () => `msg${++n}` });
  assert.deepEqual(req.model, { providerID: 'p', modelID: 'b' });
  assert.equal(req.messageID, 'msg1');
  assert.deepEqual(req.parts, base.parts);
  assert.deepEqual(req.newSession, base.newSession);
  assert.deepEqual(req.fallbackCfg, base.fallbackCfg);
  assert.equal(base.model.modelID, 'a', 'base must not be mutated');
});

test('backoff defaults to 2s/4s/8s and honours OPC_FALLBACK_BACKOFF_MS', () => {
  assert.deepEqual([...DEFAULT_BACKOFF_MS], [2000, 4000, 8000]);
  assert.deepEqual(backoffFromEnv({}), [2000, 4000, 8000]);
  assert.deepEqual(backoffFromEnv({ OPC_FALLBACK_BACKOFF_MS: '' }), [2000, 4000, 8000]);
  assert.deepEqual(backoffFromEnv({ OPC_FALLBACK_BACKOFF_MS: '10, 20' }), [10, 20]);
  assert.deepEqual(backoffFromEnv({ OPC_FALLBACK_BACKOFF_MS: 'x,1' }), [2000, 4000, 8000]);
  assert.deepEqual(backoffFromEnv({ OPC_FALLBACK_BACKOFF_MS: '-1' }), [2000, 4000, 8000]);
});

test('backoffDelay indexes by retry and clamps to the last value', () => {
  assert.equal(backoffDelay([2000, 4000, 8000], 0), 2000);
  assert.equal(backoffDelay([2000, 4000, 8000], 1), 4000);
  assert.equal(backoffDelay([2000, 4000, 8000], 2), 8000);
  assert.equal(backoffDelay([2000, 4000, 8000], 7), 8000);
  assert.equal(backoffDelay([], 0), 0);
});

test('abortableSleep resolves true after the delay and false when aborted', async () => {
  assert.equal(await abortableSleep(5), true);
  const ac = new AbortController();
  const pending = abortableSleep(10_000, ac.signal);
  ac.abort();
  assert.equal(await pending, false);
  assert.equal(await abortableSleep(5, ac.signal), false);
});
