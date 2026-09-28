import test from 'node:test';
import assert from 'node:assert/strict';

import reviewOk, { REVIEW_OK_STRUCTURED } from '../fixtures/scenarios/review-ok.mjs';
import reviewStructuredError from '../fixtures/scenarios/review-structured-error.mjs';
import reviewSlow from '../fixtures/scenarios/review-slow.mjs';
import stopAllow from '../fixtures/scenarios/stop-allow.mjs';
import stopBlock from '../fixtures/scenarios/stop-block.mjs';
import stopMalformed from '../fixtures/scenarios/stop-malformed.mjs';
import { fixtureModelIds } from '../f2b-helpers.mjs';
import { validateReviewShapeForFixture } from './f2b-scenarios.shape.mjs';

function capture(scenario, body) {
  const calls = [];
  const fake = { emitTurn: (sessionID, opts) => calls.push({ sessionID, opts }) };
  scenario.onPromptAsync(fake, 'ses_test', body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, 'ses_test');
  return calls[0].opts;
}

const JSON_BODY = { parts: [{ type: 'text', text: 'review' }], format: { type: 'json_schema', schema: { type: 'object' } } };
const TEXT_BODY = { parts: [{ type: 'text', text: 'gate' }] };

test('review-ok answers json_schema prompts with the structured review', () => {
  const opts = capture(reviewOk, JSON_BODY);
  assert.deepEqual(opts.structured, REVIEW_OK_STRUCTURED);
  assert.equal(validateReviewShapeForFixture(REVIEW_OK_STRUCTURED), null);
  const text = capture(reviewOk, TEXT_BODY);
  assert.equal(text.structured, undefined);
  assert.deepEqual(JSON.parse(text.text.split('\n')[1]), REVIEW_OK_STRUCTURED);
});

test('review-structured-error emits StructuredOutputError with raw text', () => {
  const opts = capture(reviewStructuredError, JSON_BODY);
  assert.equal(opts.error.name, 'StructuredOutputError');
  assert.equal(typeof opts.error.data.message, 'string');
  assert.equal(opts.error.data.retries, 2);
  assert.match(opts.text, /RAW_REVIEW_TEXT/);
});

test('review-slow delays the turn by FAKE_SLOW_MS', () => {
  const previous = process.env.FAKE_SLOW_MS;
  process.env.FAKE_SLOW_MS = '1234';
  try {
    assert.equal(capture(reviewSlow, JSON_BODY).delayMs, 1234);
    assert.deepEqual(capture(reviewSlow, JSON_BODY).structured, REVIEW_OK_STRUCTURED);
    assert.match(capture(reviewSlow, TEXT_BODY).text, /^ALLOW:/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_SLOW_MS;
    else process.env.FAKE_SLOW_MS = previous;
  }
});

test('stop scenarios answer with ALLOW, BLOCK or an off-contract first line', () => {
  assert.match(capture(stopAllow, TEXT_BODY).text, /^ALLOW: /);
  assert.match(capture(stopBlock, TEXT_BODY).text, /^BLOCK: divide\(\) retorna a \/ 0 em math\.js/);
  assert.doesNotMatch(capture(stopMalformed, TEXT_BODY).text, /^(ALLOW|BLOCK):/);
});

test('the provider fixture exposes at least one connected model', () => {
  const ids = fixtureModelIds();
  assert.ok(ids.length >= 1, 'tests/fixtures/data/provider.json must list a connected model');
  for (const id of ids) assert.match(id, /^[^/]+\/.+/);
});
