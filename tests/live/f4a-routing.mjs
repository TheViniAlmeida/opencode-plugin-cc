import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAST, SECOND, THIRD, INVALID, SKIP, TIMEOUT, PROMPT, baseConfig, liveSetup, runCli, jobsIn, transcript } from './_f4a-lib.mjs';

for (const [name, args, cfg, expected, check] of [
  ['routing-first', ['ask', PROMPT], baseConfig(), FAST, () => {}],
  ['routing-tier-heavy', ['ask', '--tier', 'heavy', PROMPT], baseConfig(), THIRD, () => {}],
  ['routing-denied-entry', ['ask', PROMPT], baseConfig({ deny: [`*${FAST.split('/').at(-1)}*`] }), SECOND, (r) => assert.match(r.stderr, /\[opc\] warning:/)],
  ['routing-invalid-entry', ['ask', PROMPT], baseConfig({ ask: [INVALID, FAST] }), FAST, (r) => assert.match(r.stderr, /does-not-exist-f4a/)],
]) {
  const skip = SKIP || (name === 'routing-denied-entry' && SECOND === FAST
    ? 'OPC_LIVE_MODEL_2 não definida com uma rota distinta; não há candidato alternativo para testar a negação.'
    : false);
  test(`live: ${name}`, { skip, timeout: TIMEOUT }, async (t) => {
    const { env, ws, dataDir } = liveSetup(t, cfg);
    let r;
    try {
      r = await runCli(args, { env, cwd: ws, timeoutMs: TIMEOUT });
      const [job] = jobsIn(env, ws);
      transcript(name, dataDir, [`exit=${r.code}`, `model=${job?.model}`, `status=${job?.status}`, `attempts=${JSON.stringify(job?.attempts?.map(({ model, status, errorClass, errorType }) => ({ model, status, errorClass, errorType })) ?? [])}`, r.stderr]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(job?.status, 'completed');
      assert.equal(job?.model, expected);
      check(r);
    } finally { const { cleanupLive } = await import('./_f4a-lib.mjs'); await cleanupLive(env, ws); }
  });
}
