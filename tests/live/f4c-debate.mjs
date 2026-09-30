import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, EXTRA, QUESTION, liveSetup, liveConclave, attempts, schemas, transcript } from './_f4c-lib.mjs';

test('F4c live: debate with 2 rounds, round-2 answers valid with changed recorded (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const members = EXTRA ? [...BASE_POOL, EXTRA] : BASE_POOL;
  t.diagnostic(`debate members: ${members.length} (extra: ${EXTRA ? 'OPC_LIVE_MODEL_4' : 'none — OPC_LIVE_MODEL_4 not set'})`);
  const { debate } = schemas();
  const results = await attempts(3, async () => {
    const res = await liveConclave(['--models', members.join(','), '--mode', 'debate', '--rounds', '2', '--json', QUESTION], ctx);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.deepEqual(pkg.rounds, { requested: 2, completed: 2 });
    const round1Labels = pkg.roundsData[0].responses.map((r) => r.label);
    const round2 = pkg.roundsData[1].responses;
    assert.ok(round2.length >= pkg.quorum);
    for (const r of round2) {
      const peers = round1Labels.filter((l) => l !== r.label);
      assert.deepEqual(validateSchema(r.response, debate(peers)), [], `round 2 member ${r.label}`);
      assert.equal(typeof r.response.changed, 'boolean');
    }
    return { jobId: pkg.jobId, changed: round2.map((r) => [r.label, r.response.changed]), failures: pkg.failures.map((f) => [f.label, f.round, f.errorType]) };
  });
  t.diagnostic(`debate: ${JSON.stringify(results)}`);
  transcript(`debate (2 rodadas, ${members.length} membros)`, ctx.dataDir, results);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});
