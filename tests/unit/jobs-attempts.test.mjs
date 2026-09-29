import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import {
  createJob, readJob, recordAttempt, runJobTurn,
} from '../../plugins/opc/scripts/lib/jobs.mjs';

function tempStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-f4a-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  await assert.rejects(recordAttempt(stateDir, 'ask-nope', {}), (err) => err.code === 'NOT_FOUND');
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
