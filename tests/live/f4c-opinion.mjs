import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, QUESTION, liveSetup, liveConclave, attempts, schemas, transcript } from './_f4c-lib.mjs';

test('F4c live: opinion with 3 models, every answer schema-valid (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const { member } = schemas();
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', BASE_POOL.join(','), '--json', QUESTION], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.deepEqual(pkg.failures, []);
    assert.equal(pkg.final.responses.length, BASE_POOL.length);
    for (const r of pkg.final.responses) assert.deepEqual(validateSchema(r.response, member), [], `member ${r.label}`);
    return { jobId: pkg.jobId, durationMs: pkg.durationMs, confidences: pkg.final.responses.map((r) => [r.label, r.response.confidence]) };
  });
  t.diagnostic(`opinion: ${JSON.stringify(results)}`);
  transcript('opinion (3 membros)', ctx.dataDir, results);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
