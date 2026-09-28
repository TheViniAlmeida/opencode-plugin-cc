import test from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewOutput } from '../../plugins/opc/scripts/lib/render.mjs';
import { LIVE_SKIP, LIVE_TIMEOUT_MS, liveCli, livePrepare, plantBug } from './_f2b-live-helpers.mjs';

test('live F2b: /opc:review returns schema-valid JSON (3 runs, at least 2 valid)', { skip: LIVE_SKIP, timeout: 3 * LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = livePrepare(t);
  plantBug(ctx.cwd);
  const outcomes = [];
  for (let run = 1; run <= 3; run += 1) {
    const result = await liveCli(ctx, ['review', '--wait', '--json', '--wait-timeout', '1080'], { timeoutMs: LIVE_TIMEOUT_MS });
    let error;
    try {
      error = validateReviewOutput(JSON.parse(result.stdout).review);
    } catch (err) {
      error = `invalid JSON output: ${err.message}`;
    }
    outcomes.push({ run, exit: result.code, valid: error === null, error });
    t.diagnostic(`review run ${run}: exit ${result.code}, ${error ?? 'schema-valid'}`);
  }
  assert.ok(outcomes.filter((outcome) => outcome.valid).length >= 2, JSON.stringify(outcomes, null, 2));
});
