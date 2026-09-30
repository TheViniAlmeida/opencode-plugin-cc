import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, liveSetup, liveConclave, attempts, failureDetails, transcript } from './_f4c-lib.mjs';

// Planted bugs: off-by-one read past the end, division by zero on empty input, eval of user input.
const BUGGY = `export function average(values) {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

export function runUserFormula(formula) {
  return eval(formula);
}
`;

test('F4c live: cross review on a real diff with k/N agreement (3 runs, >= 2 with a cluster k >= 2)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  fs.mkdirSync(path.join(ctx.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.cwd, 'src', 'stats.js'), BUGGY);
  const results = await attempts(3, async (_run, detail) => {
    const res = await liveConclave(['--models', BASE_POOL.join(','), '--mode', 'review', '--json', 'Focus on correctness and security.'], ctx);
    detail.failures = failureDetails(res.json);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const { review } = res.json;
    assert.ok(review.validMembers >= 2);
    for (const c of review.clusters) {
      assert.equal(c.agreement.n, review.validMembers);
      assert.equal(c.agreement.text, `${c.agreement.k}/${review.validMembers}`);
    }
    const agreed = review.clusters.filter((c) => c.agreement.k >= 2);
    assert.ok(agreed.length >= 1, `no cluster with k >= 2: ${JSON.stringify(review.clusters.map((c) => [c.title, c.agreement.text]))}`);
    return { jobId: res.json.jobId, verdict: review.verdict, clusters: review.clusters.map((c) => [c.severity, c.agreement.text, c.file, c.line_start, c.title]), failures: detail.failures };
  });
  t.diagnostic(`review: ${JSON.stringify(results)}`);
  transcript('review cruzado (3 membros)', ctx.dataDir, results);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
