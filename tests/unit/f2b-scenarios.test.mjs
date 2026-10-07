import test from 'node:test';
import assert from 'node:assert/strict';

import reviewOk, { REVIEW_OK_STRUCTURED } from '../fixtures/scenarios/review-ok.mjs';
import reviewStructuredError from '../fixtures/scenarios/review-structured-error.mjs';
import reviewSlow from '../fixtures/scenarios/review-slow.mjs';
import stopAllow from '../fixtures/scenarios/stop-allow.mjs';
import stopBlock from '../fixtures/scenarios/stop-block.mjs';
import stopMalformed from '../fixtures/scenarios/stop-malformed.mjs';
import { loadFixtureData } from '../fixtures/fake-opencode.mjs';
import { validateReviewShapeForFixture } from './f2b-scenarios.shape.mjs';

function capture(scenario, body) {
  const calls = [];
  const fake = { emitTurn: (sessionID, opts) => calls.push({ sessionID, opts }) };
  scenario.onPrompt(fake, 'ses_test', body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionID, 'ses_test');
  return calls[0].opts;
}

const JSON_BODY = { text: 'review' };
const TEXT_BODY = { text: 'gate' };

test('review-ok answers V2 text prompts with the review JSON', () => {
  const opts = capture(reviewOk, JSON_BODY);
  assert.deepEqual(JSON.parse(opts.text.split('\n')[1]), REVIEW_OK_STRUCTURED);
  assert.equal(validateReviewShapeForFixture(REVIEW_OK_STRUCTURED), null);
  const text = capture(reviewOk, TEXT_BODY);
  assert.equal(text.structured, undefined);
  assert.deepEqual(JSON.parse(text.text.split('\n')[1]), REVIEW_OK_STRUCTURED);
});

test('review-structured-error emits malformed text without a V1 structured error', () => {
  const opts = capture(reviewStructuredError, JSON_BODY);
  assert.equal(opts.error, undefined);
  assert.match(opts.text, /RAW_REVIEW_TEXT/);
});

test('review-slow delays the turn by FAKE_SLOW_MS', () => {
  const previous = process.env.FAKE_SLOW_MS;
  process.env.FAKE_SLOW_MS = '1234';
  try {
    assert.equal(capture(reviewSlow, JSON_BODY).delayMs, 1234);
    assert.deepEqual(JSON.parse(capture(reviewSlow, JSON_BODY).text.split('\n')[1]), REVIEW_OK_STRUCTURED);
    assert.deepEqual(JSON.parse(capture(reviewSlow, TEXT_BODY).text.split('\n')[1]), REVIEW_OK_STRUCTURED);
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

test('the V2 model fixture exposes at least one model', () => {
  const ids = loadFixtureData('model.json').map((model) => model.id);
  assert.ok(ids.length >= 1, 'tests/fixtures/data/model.json must list a model');
  for (const id of ids) assert.match(id, /^[^/]+\/.+/);
});
