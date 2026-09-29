import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import {
  createJob, readJob, recordAttempt, runJobTurn, updateJob,
} from '../../plugins/opc/scripts/lib/jobs.mjs';

function tempStateDir(t) {
  const dir = trackTempDir(t, makeTempDir('opc-f4a-jobs-'));
  const stateDir = path.join(dir, 'state');
  ensurePrivateDir(stateDir);
  return stateDir;
}

const A = { providerID: 'p', modelID: 'a', full: 'p/a', source: 'routing.tasks.ask', contextLimit: null };
const B = { providerID: 'p', modelID: 'b', full: 'p/b', source: 'routing.tasks.ask', contextLimit: null };
const BASE = {
  newSession: { title: 'OPC: ask: hi', permission: [] },
  parts: [{ type: 'text', text: 'hi' }],
  model: { providerID: 'p', modelID: 'a' },
  messageID: 'msgBASE',
  timeoutMs: 1000,
};
const CONFIG = { routing: { fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } } };
const okTurn = (req) => ({ status: 'completed', sessionID: `ses_${req.model.modelID}`, finalText: 'ok', toolsRan: false, touchedFiles: [], toolNames: [] });
const failTurn = (req, extra = {}) => ({
  status: 'failed', sessionID: `ses_${req.model.modelID}`, errorClass: 'recoverable', errorType: 'APIError',
  errorMessage: 'rate limited', toolsRan: false, touchedFiles: [], toolNames: [], ...extra,
});
const logOf = (stateDir, id) => fs.readFileSync(path.join(stateDir, 'jobs', `${id}.log`), 'utf8');

test('recordAttempt appends to attempts[] in order', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x' });
  await recordAttempt(stateDir, job.id, { model: 'p/a', status: 'failed' });
  await recordAttempt(stateDir, job.id, { model: 'p/b', status: 'completed' });
  assert.deepEqual(readJob(stateDir, job.id).attempts.map((a) => a.model), ['p/a', 'p/b']);
});

test('recordAttempt on an unknown job fails with NOT_FOUND', async (t) => {
  const stateDir = tempStateDir(t);
  const missingId = 'ask-1234567890abcdef-abcdef';
  await assert.rejects(recordAttempt(stateDir, missingId, {}), (err) => err.code === 'NOT_FOUND' && err.message.endsWith(missingId));
});

test('recordAttempt preserves INVALID_JSON when the job file cannot be parsed', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x' });
  fs.writeFileSync(path.join(stateDir, 'jobs', `${job.id}.json`), '{ invalid');
  await assert.rejects(recordAttempt(stateDir, job.id, { model: 'p/a' }), (err) => err.code === 'INVALID_JSON');
});

test('recordAttempt masks provider text in persisted attempts and fallback log', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: { candidates: [A, B], fallbackEligible: true } });
  const secretLike = ['sk', 'proj', Math.random().toString(36).slice(2, 14)].join('-');
  await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: BASE, backoffMs: [0], sleep: async () => true,
    runTurnImpl: async (opts) => failTurn(opts.request, {
      errorType: `ProviderError ${secretLike}`,
      errorMessage: `provider failed: ${secretLike}`,
      error: `raw error: ${secretLike}`,
    }),
  });
  const persisted = fs.readFileSync(path.join(stateDir, 'jobs', `${job.id}.json`), 'utf8');
  const log = logOf(stateDir, job.id);
  assert.ok(!persisted.includes(secretLike));
  assert.ok(!log.includes(secretLike));
  assert.match(persisted, /\*\*\*/);
  assert.match(log, /\*\*\*/);
});

test('redactTurnOutput masks provider-derived text in result.attempts', async (t) => {
  const { redactTurnOutput } = await import('../../plugins/opc/scripts/lib/redact.mjs');
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x' });
  const secretLike = ['sk', 'proj', Math.random().toString(36).slice(2, 14)].join('-');
  const safe = redactTurnOutput({ attempts: [{ errorType: `ProviderError ${secretLike}`, errorMessage: `failed ${secretLike}` }] });
  assert.ok(!JSON.stringify(safe).includes(secretLike));
  assert.match(safe.attempts[0].errorType, /\*\*\*/);
  assert.match(safe.attempts[0].errorMessage, /\*\*\*/);
  await updateJob(stateDir, job.id, { result: safe });
  const persisted = fs.readFileSync(path.join(stateDir, 'jobs', `${job.id}.json`), 'utf8');
  assert.ok(!persisted.includes(secretLike));
});

test('runJobTurn falls back, records attempts, model, attemptLimit and log lines', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, {
    kind: 'ask', title: 'OPC: ask: x', permissionProfile: 'read-only',
    request: { candidates: [A, B], fallbackEligible: true, routingWarnings: ['ignorado p/x: negado pela política'] },
  });
  const seen = [];
  const out = await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: BASE, runTurnOptions: { api: 'API', hub: 'HUB' },
    backoffMs: [5], sleep: async () => true, messageId: () => 'msgNEW',
    runTurnImpl: async (opts) => {
      seen.push(opts);
      return seen.length === 1 ? failTurn(opts.request) : okTurn(opts.request);
    },
  });
  assert.equal(out.stopReason, 'completed');
  assert.equal(out.stop, null);
  assert.deepEqual(seen.map((o) => o.request.model.modelID), ['a', 'b']);
  assert.deepEqual(seen.map((o) => o.request.messageID), ['msgBASE', 'msgNEW']);
  assert.equal(seen[0].api, 'API');
  assert.equal(seen[0].hub, 'HUB');
  assert.deepEqual(seen[0].request.fallbackCfg, CONFIG.routing.fallback);
  assert.deepEqual(seen[1].request.newSession, BASE.newSession);
  const saved = readJob(stateDir, job.id);
  assert.equal(saved.attemptLimit, 2);
  assert.equal(saved.model, 'p/b');
  assert.deepEqual(saved.attempts.map((a) => [a.model, a.status, a.errorClass]), [['p/a', 'failed', 'recoverable'], ['p/b', 'completed', null]]);
  const log = logOf(stateDir, job.id);
  assert.match(log, /aviso: ignorado p\/x: negado pela política/);
  assert.match(log, /tentativa 2\/2: p\/b/);
  assert.match(log, /fallback: APIError em p\/a; próximo p\/b em 0\.005s/);
});

test('runJobTurn never falls back on resume (sessionID in the base request)', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: { candidates: [A, B], fallbackEligible: true } });
  let calls = 0;
  const out = await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: { ...BASE, newSession: undefined, sessionID: 'ses_old' },
    backoffMs: [0], sleep: async () => true,
    runTurnImpl: async (o) => {
      calls += 1;
      return failTurn(o.request);
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.stopReason, 'not-eligible');
  assert.equal(readJob(stateDir, job.id).attemptLimit, 1);
});

test('runJobTurn refuses fallback in a write turn that ran tools and explains why', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'task', title: 'OPC: task: x', permissionProfile: 'write', request: { candidates: [A, B], fallbackEligible: true } });
  const out = await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: BASE, backoffMs: [0], sleep: async () => true,
    runTurnImpl: async (o) => failTurn(o.request, { toolsRan: true, touchedFiles: ['src/app.js'], toolNames: ['edit'] }),
  });
  assert.equal(out.stopReason, 'write-tools-ran');
  assert.equal(out.stop.errorCode, 'WRITE_NO_FALLBACK');
  assert.match(out.stop.errorMessage, /src\/app\.js/);
  assert.equal(readJob(stateDir, job.id).attempts.length, 1);
});

test('runJobTurn works for legacy requests without candidates (single model)', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: {} });
  const seen = [];
  const out = await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: BASE,
    runTurnImpl: async (o) => {
      seen.push(o.request.model);
      return okTurn(o.request);
    },
  });
  assert.equal(out.stopReason, 'completed');
  assert.deepEqual(seen, [{ providerID: 'p', modelID: 'a' }]);
  assert.equal(readJob(stateDir, job.id).model, 'p/a');
  assert.equal(readJob(stateDir, job.id).attemptLimit, 1);
});

test('runJobTurn reports a cancel during backoff as a cancelled result', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: { candidates: [A, B], fallbackEligible: true } });
  const ac = new AbortController();
  let calls = 0;
  const out = await runJobTurn({
    stateDir, job, config: CONFIG, baseTurnRequest: BASE, runTurnOptions: { signal: ac.signal }, backoffMs: [10_000],
    sleep: async () => {
      ac.abort();
      return false;
    },
    runTurnImpl: async (o) => {
      calls += 1;
      return failTurn(o.request);
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.stopReason, 'cancelled');
  assert.equal(out.result.status, 'cancelled');
  assert.equal(readJob(stateDir, job.id).attempts.length, 1);
});

test('runJobTurn cancelled before the first attempt records no attempt and returns null result', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: { candidates: [A, B], fallbackEligible: true } });
  await updateJob(stateDir, job.id, { cancelRequestedAt: new Date().toISOString() });
  let calls = 0;
  const out = await runJobTurn({
    stateDir, job: readJob(stateDir, job.id), config: CONFIG, baseTurnRequest: BASE,
    runTurnImpl: async () => { calls += 1; return okTurn(BASE); },
  });
  assert.equal(calls, 0, 'must issue no prompt_async request');
  assert.deepEqual(out.result, { status: 'cancelled' });
  assert.equal(out.stopReason, 'cancelled');
  assert.deepEqual(readJob(stateDir, job.id).attempts, []);
});

test('runJobTurn respects routing.fallback.maxAttempts in attemptLimit', async (t) => {
  const stateDir = tempStateDir(t);
  const C = { ...B, modelID: 'c', full: 'p/c' };
  const job = await createJob(stateDir, { kind: 'ask', title: 'OPC: ask: x', request: { candidates: [A, B, C], fallbackEligible: true } });
  const out = await runJobTurn({
    stateDir, job, config: { routing: { fallback: { enabled: true, maxAttempts: 2 } } }, baseTurnRequest: BASE,
    backoffMs: [0], sleep: async () => true, runTurnImpl: async (o) => failTurn(o.request),
  });
  assert.equal(out.stopReason, 'max-attempts');
  assert.equal(readJob(stateDir, job.id).attemptLimit, 2);
  assert.equal(out.stop.errorCode, 'FALLBACK_EXHAUSTED');
});

for (const mode of ['intent', 'cancel-false', 'signal']) {
  test(`F4a C2: backoff wakes promptly on ${mode} without a new prompt`, async (t) => {
    const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
    const stateDir = tempStateDir(t);
    const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a', request: { candidates: [A, B], fallbackEligible: true } });
    const ac = new AbortController();
    let calls = 0;
    let aborts = 0;
    const running = runJobTurn({ stateDir, job, config: CONFIG, baseTurnRequest: BASE,
      backoffMs: [1500], runTurnOptions: { signal: ac.signal },
      runTurnImpl: async (o) => { calls++; return failTurn(o.request); },
    });
    while (readJob(stateDir, job.id).phase !== 'fallback') await new Promise((r) => setTimeout(r, 5));
    const start = performance.now();
    if (mode === 'signal') ac.abort();
    else if (mode === 'intent') await updateJob(stateDir, job.id, { cancelRequestedAt: new Date().toISOString() });
    else {
      const cancelled = await cancelJob({ stateDir }, job.id, { api: { abort: async () => { aborts++; return false; } } });
      assert.notEqual(cancelled.ok, false);
      assert.equal(cancelled.job.status, 'cancelled');
      assert.ok(cancelled.job.cancelRequestedAt);
    }
    const outcome = await running;
    assert.equal(outcome.result.status, 'cancelled');
    assert.equal(calls, 1, 'zero new prompt_async after cancellation');
    assert.equal(aborts, 0, 'finished session must not be aborted');
    assert.ok(performance.now() - start < 800, 'must wake before the backoff ends');
  });
}

test('F4a C2: cancel during backoff holds even when a late progress update overwrote the phase', async (t) => {
  const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a', request: { candidates: [A, B], fallbackEligible: true } });
  let calls = 0;
  let aborts = 0;
  const running = runJobTurn({ stateDir, job, config: CONFIG, baseTurnRequest: BASE, backoffMs: [1500],
    runTurnImpl: async (o) => { calls++; return failTurn(o.request); },
  });
  while (readJob(stateDir, job.id).phase !== 'fallback') await new Promise((r) => setTimeout(r, 5));
  // a queued progress update from the finished turn lands after the backoff started
  await updateJob(stateDir, job.id, { phase: 'running', sessionID: 'ses_a' });
  const cancelled = await cancelJob({ stateDir }, job.id, { api: { abort: async () => { aborts++; return false; } } });
  assert.notEqual(cancelled.ok, false);
  assert.equal(cancelled.job.status, 'cancelled');
  const outcome = await running;
  assert.equal(outcome.result.status, 'cancelled');
  assert.equal(calls, 1, 'no new attempt after cancellation');
  assert.equal(aborts, 0, 'the finished session is not aborted');
});

test('F4a I1: cancel racing with completion waits for the final attempt to be persisted', async (t) => {
  const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a', request: { candidates: [A], fallbackEligible: false } });
  let finishTurn;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const completing = new Promise((r) => { finishTurn = r; });
  const running = runJobTurn({ stateDir, job, config: CONFIG, baseTurnRequest: BASE,
    runTurnImpl: async () => { entered(); return completing; },
  });
  await started;
  const cancelling = cancelJob({ stateDir }, job.id, { api: {
    abort: async () => { setTimeout(() => finishTurn(okTurn(BASE)), 30); return true; },
    sessionStatus: async () => ({}),
  }, exitWaitMs: 500 });
  await Promise.all([running, cancelling]);
  const saved = readJob(stateDir, job.id);
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].status, 'completed');
  assert.equal(saved.attempts[0].sessionID, 'ses_a');
});

for (const status of ['completed', 'failed']) {
  test(`F4a I1: cancellation after recording a ${status} attempt respects session liveness`, async (t) => {
    const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
    const stateDir = tempStateDir(t);
    const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a' });
    await recordAttempt(stateDir, job.id, { model: 'p/a', sessionID: 'ses_a', status,
      ...(status === 'failed' ? { errorType: 'AbortUnconfirmed', errorClass: 'fatal' } : {}),
    });
    let aborts = 0;
    const outcome = await cancelJob({ stateDir }, job.id, { api: { abort: async () => { aborts++; return false; } } });
    assert.equal(aborts, status === 'completed' ? 0 : 1);
    assert.equal(outcome.job.attempts.length, 1);
    assert.equal(outcome.job.status, status === 'completed' ? 'cancelled' : 'queued');
    if (status === 'failed') assert.equal(outcome.ok, false);
  });
}

for (const errorType of ['CallbackFailed', 'ChildPermissionFailed']) {
  test(`F4a C2: a ${errorType} attempt with unconfirmed aborts is still aborted on cancel`, async (t) => {
    const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
    const stateDir = tempStateDir(t);
    const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a', childSessionIDs: ['ses_child'] });
    await recordAttempt(stateDir, job.id, { model: 'p/a', sessionID: 'ses_a', status: 'failed', errorClass: 'fatal', errorType, abortConfirmed: false });
    const aborted = [];
    const outcome = await cancelJob({ stateDir }, job.id, { api: { abort: async (id) => { aborted.push(id); return false; } } });
    assert.deepEqual(aborted, ['ses_a'], 'abort is attempted again instead of skipped');
    assert.equal(outcome.ok, false);
  });
}

test('F4a C2: runWithFallback records abortConfirmed=false on the attempt', async (t) => {
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', request: { candidates: [A, B], fallbackEligible: true } });
  await runJobTurn({ stateDir, job, config: CONFIG, baseTurnRequest: BASE, backoffMs: [0], sleep: async () => true,
    runTurnImpl: async (o) => ({ ...failTurn(o.request), errorClass: 'fatal', errorType: 'CallbackFailed', abortConfirmed: false }),
  });
  assert.equal(readJob(stateDir, job.id).attempts[0].abortConfirmed, false);
});

test('F4a I1: a pending attempt keeps cancellation intent if publication exceeds the bounded wait', async (t) => {
  const { cancelJob } = await import('../../plugins/opc/scripts/lib/jobs.mjs');
  const stateDir = tempStateDir(t);
  const job = await createJob(stateDir, { kind: 'ask', sessionID: 'ses_a' });
  await updateJob(stateDir, job.id, { attemptInFlight: true });
  const pending = await cancelJob({ stateDir }, job.id, {
    api: { abort: async () => true, sessionStatus: async () => ({}) }, exitWaitMs: 1,
  });
  assert.equal(pending.ok, false);
  assert.ok(pending.job.cancelRequestedAt);
  assert.equal(pending.job.status, 'queued', 'never freeze a record before its final attempt');
  await recordAttempt(stateDir, job.id, { model: 'p/a', sessionID: 'ses_a', status: 'completed' });
  await updateJob(stateDir, job.id, { status: 'cancelled' });
  assert.equal(readJob(stateDir, job.id).attempts.length, 1);
});
