import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { SKIP, LIVE_TIMEOUT_MS, BASE_POOL, JUDGE, QUESTION, liveSetup, liveConclave, attempts, failureDetails, schemas, familyWords, transcript } from './_f4c-lib.mjs';

// Two members plus a model judge outside the members (no --allow-judge-member needed).
const MEMBERS = BASE_POOL.filter((m) => m !== JUDGE).slice(0, 2);

test('F4c live: judge by model returns a schema-valid synthesis (3 runs, >= 2 pass)', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const { synthesis } = schemas();
  const results = await attempts(3, async (_run, detail) => {
    const res = await liveConclave(['--models', MEMBERS.join(','), '--judge', JUDGE, '--json', QUESTION], ctx);
    detail.failures = failureDetails(res.json);
    assert.equal(res.code, 0, res.stderr.slice(-2000));
    const pkg = res.json;
    assert.equal(pkg.judge.type, 'model');
    assert.equal(pkg.judge.status, 'completed', JSON.stringify(pkg.judge.error ?? null));
    const labels = pkg.final.responses.map((r) => r.label);
    assert.deepEqual(validateSchema(pkg.judge.synthesis, synthesis(labels)), []);
    return { jobId: pkg.jobId, confidence: pkg.judge.synthesis.confidence, recommendation: pkg.judge.synthesis.recommendation.slice(0, 200), failures: detail.failures };
  });
  t.diagnostic(`judge-model: ${JSON.stringify(results)}`);
  transcript('juiz modelo (2 membros + juiz)', ctx.dataDir, results);
  assert.ok(results.filter((r) => r.ok).length >= 2, JSON.stringify(results));
});

test('F4c live: judge Claude receives an anonymized package ready for the opc-conclave skill', { skip: SKIP, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const ctx = liveSetup(t);
  const res = await liveConclave(['--models', BASE_POOL.join(','), '--judge', 'claude', '--json', QUESTION], ctx);
  assert.equal(res.code, 0, res.stderr.slice(-2000));
  const pkg = res.json;
  assert.deepEqual(pkg.judge, { type: 'claude', status: 'pending' });
  assert.ok(pkg.synthesisInput.responses.length >= pkg.quorum);
  const { question, ...handed } = pkg.synthesisInput;
  const text = JSON.stringify(handed).toLowerCase();
  for (const word of familyWords(BASE_POOL)) assert.ok(!text.includes(word.toLowerCase()), `"${word}" leaked into synthesisInput`);
  t.diagnostic(`judge-claude jobId: ${pkg.jobId}`);
  transcript('juiz Claude (pacote anonimizado)', ctx.dataDir, [{ run: 1, ok: true, seconds: Math.round(pkg.durationMs / 1000), detail: { jobId: pkg.jobId, responses: pkg.synthesisInput.responses.length, failures: failureDetails(pkg) } }]);
  // Keep the anonymized package for the controller's opc-conclave synthesis (gate §5), outside the repo.
  if (process.env.OPC_LIVE_F4C_PACKAGE) (await import('node:fs')).writeFileSync(process.env.OPC_LIVE_F4C_PACKAGE, JSON.stringify(pkg, null, 2), { mode: 0o600 });
});
