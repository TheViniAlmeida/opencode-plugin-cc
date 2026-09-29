import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAST, SKIP, TIMEOUT, PROMPT, baseConfig, liveSetup, runCli, jobsIn, transcript } from './_f4a-lib.mjs';

const FAILING = process.env.OPC_LIVE_FAILING_MODEL?.trim() ?? '';
const FALLBACK_SKIP = SKIP || (!FAILING && 'NÃO VALIDADO: defina OPC_LIVE_FAILING_MODEL com um modelo que falhe de modo recuperável; use probe-failing-model.mjs.');

test('live: fallback picks the next configured route after a recoverable failure', { skip: FALLBACK_SKIP, timeout: TIMEOUT }, async (t) => {
  const { env, ws, dataDir } = liveSetup(t, baseConfig({ ask: [FAILING, FAST] }), 'opc-live-f4a-fb-');
  let r;
  try {
    r = await runCli(['ask', PROMPT], { env, cwd: ws, timeoutMs: TIMEOUT });
    const [job] = jobsIn(env, ws);
    const attempts = job?.attempts ?? [];
    transcript('fallback', dataDir, [`exit=${r.code}`, `status=${job?.status}`, `attempts=${JSON.stringify(attempts.map(({ model, status, errorClass, errorType }) => ({ model, status, errorClass, errorType })))}`, r.stderr]);
    assert.notEqual(attempts[0]?.errorClass, 'fatal', 'Falha classificada como fatal (por exemplo, APIError 402/401). Escolha outro OPC_LIVE_FAILING_MODEL com falha recuperável.');
    assert.equal(attempts[0]?.model, FAILING, 'A primeira tentativa não usou OPC_LIVE_FAILING_MODEL.');
    assert.equal(attempts[0]?.errorClass, 'recoverable', 'Escolha outro OPC_LIVE_FAILING_MODEL: a primeira falha precisa ser recuperável.');
    assert.equal(attempts[1]?.model, FAST);
    assert.equal(attempts[1]?.status, 'completed');
    assert.equal(job?.status, 'completed');
    assert.equal(r.code, 0, r.stderr);
  } finally { const { cleanupLive } = await import('./_f4a-lib.mjs'); await cleanupLive(env, ws); }
});
