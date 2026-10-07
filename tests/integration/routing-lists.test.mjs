import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  testEnv, makeWorkspace, runCli, FIXTURE_MODELS as M, writeGlobalConfig,
  jobsIn, promptModels, requestsTo,
} from '../helpers.mjs';

const NO_SUCH_MODEL = 'omniroute-personal/opencode-go/no-such-model-f4a';

const BASE_POLICY = {
  providers: { allow: [], deny: [] },
  models: { allow: [], deny: [] },
  agents: { allow: [], deny: [] },
  tools: { deny: [] },
  sensitivePaths: ['*.env', '*.env.*'],
  destructiveBash: [],
  approver: 'user',
  permissionTimeoutSec: 600,
};

function config({ tasks = {}, tiers = {}, modelDeny = [], reviewModel = null } = {}) {
  return {
    defaultProvider: 'omniroute-personal',
    defaultModel: M.fast,
    reviewModel,
    policy: { ...BASE_POLICY, models: { allow: [], deny: modelDeny } },
    routing: {
      tasks: { ask: [M.fast, M.k3], plan: [M.strong, M.k3], review: [M.strong, M.k3], task: [M.fast, M.strong], ...tasks },
      tiers: { light: [M.fast], heavy: [M.strong, M.k3], ...tiers },
      fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 },
    },
  };
}

function setup(t, scenario, cfg, extra = {}) {
  const env = testEnv(t, { scenario, extra: { OPC_FALLBACK_BACKOFF_MS: '50', ...extra } });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, cfg);
  return { env, ws };
}

const output = (r) => `${r.stdout}\n${r.stderr}`;

test('a denied list entry is skipped with a warning', async (t) => {
  const { env, ws } = setup(t, 'ok', config({ modelDeny: [M.fast] }));
  const r = await runCli(['ask', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.match(r.stderr, /\[opc\] aviso: ignorado .*modelo .* negado pela política/);
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('[opc] aviso: ignorado ') && line.includes(M.fast)).length, 1, r.stderr);
  assert.ok(r.stderr.includes(`modelo ${M.fast} negado pela política`), r.stderr);
  assert.ok(r.stderr.includes(`policy.models.deny: ${M.fast}`), r.stderr);
  assert.deepEqual(promptModels(env), [M.k3]);
  const [job] = jobsIn(env, ws);
  assert.equal(job.request.routingWarnings.length, 1);
  assert.equal(job.request.candidates.length, 1);
});

test('an invalid list entry is skipped with a warning', async (t) => {
  const { env, ws } = setup(t, 'ok', config({ tasks: { ask: [NO_SUCH_MODEL, M.k3] } }));
  const r = await runCli(['ask', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.match(r.stderr, /\[opc\] aviso: ignorado .*modelo desconhecido/);
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('[opc] aviso: ignorado ') && line.includes(NO_SUCH_MODEL)).length, 1, r.stderr);
  assert.ok(r.stderr.includes(`modelo desconhecido "${NO_SUCH_MODEL}"`), r.stderr);
  assert.deepEqual(promptModels(env), [M.k3]);
});

test('a list where every entry is denied fails with exit 4 before any session', async (t) => {
  const { env, ws } = setup(t, 'ok', config({ tasks: { ask: [M.fast] }, modelDeny: [M.fast] }));
  const r = await runCli(['ask', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 4, output(r));
  assert.match(output(r), /nenhum modelo utilizável/);
  assert.equal(requestsTo(env, 'POST', /^\/api\/session$/).length, 0);
});

test('--tier heavy uses routing.tiers.heavy and keeps fallback', async (t) => {
  const { env, ws } = setup(t, 'model-429', config(), { FAKE_FAIL_MODELS: M.strong });
  const r = await runCli(['plan', '--tier', 'heavy', 'Plan the refactor of the parser'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.deepEqual(promptModels(env), [M.strong, M.k3]);
  const [job] = jobsIn(env, ws);
  assert.equal(job.attempts.length, 2);
});

test('--tier light on task uses routing.tiers.light', async (t) => {
  const { env, ws } = setup(t, 'ok', config());
  const r = await runCli(['task', '--tier', 'light', 'Explain the build script'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.deepEqual(promptModels(env), [M.fast]);
  assert.equal(jobsIn(env, ws)[0].attemptLimit, 1);
});

test('--tier with an unknown value is a usage error (exit 2)', async (t) => {
  const { env, ws } = setup(t, 'ok', config());
  const r = await runCli(['ask', '--tier', 'medium', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 2, output(r));
  assert.match(output(r), /--tier deve ser um de: light, heavy/);
  assert.deepEqual(promptModels(env), []);
});

test('--tier naming an empty tier is a usage error (exit 2)', async (t) => {
  const { env, ws } = setup(t, 'ok', config({ tiers: { light: [] } }));
  const r = await runCli(['ask', '--tier', 'light', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 2, output(r));
  assert.match(output(r), /routing\.tiers\.light está vazio/);
});

test('--model wins over --tier and disables fallback', async (t) => {
  const { env, ws } = setup(t, 'ok', config());
  const r = await runCli(['ask', '--model', M.k3, '--tier', 'heavy', 'Where is main?'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.deepEqual(promptModels(env), [M.k3]);
  assert.equal(jobsIn(env, ws)[0].attemptLimit, 1);
});

test('review with reviewModel null uses routing.tasks.review with fallback', async (t) => {
  const { env, ws } = setup(t, 'model-429', config(), { FAKE_FAIL_MODELS: M.strong });
  fs.writeFileSync(path.join(ws, 'app.js'), 'console.log("hello");\n');
  const r = await runCli(['review', '--wait'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  assert.deepEqual(promptModels(env), [M.strong, M.k3]);
  const [job] = jobsIn(env, ws);
  assert.equal(job.kind, 'review');
  assert.equal(job.attempts.length, 2);
});

test('review with a single reviewModel has no fallback', async (t) => {
  const { env, ws } = setup(t, 'model-429', config({ reviewModel: M.strong }), { FAKE_FAIL_MODELS: M.strong });
  fs.writeFileSync(path.join(ws, 'app.js'), 'console.log("hello");\n');
  const r = await runCli(['review', '--wait'], { env, cwd: ws });
  assert.equal(r.code, 7, output(r));
  assert.deepEqual(promptModels(env), [M.strong]);
});

test('F4a I2: stopGate.model null uses route-list fallback with per-model scenarios', async (t) => {
  const cfg = config({ tasks: { 'stop-gate': [M.fast, M.k3] } });
  cfg.stopGate = { enabled: true, model: null };
  const { env, ws } = setup(t, 'stop-fallback', cfg, { FAKE_FAIL_MODELS: M.fast });
  const r = await runCli(['hook-stop'], { env, cwd: ws, stdin: JSON.stringify({ cwd: ws, session_id: 'gate-fallback', last_assistant_message: 'Finished.' }) });
  assert.equal(r.code, 0, output(r));
  assert.equal(r.stdout.trim(), '', 'successful ALLOW, not infrastructure fail-open');
  assert.deepEqual(promptModels(env), [M.fast, M.k3]);
  const [job] = jobsIn(env, ws);
  assert.equal(job.kind, 'stop-gate');
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.attempts.map((a) => a.status), ['failed', 'completed']);
});

test('F4a I3: review and result JSON expose review fallback attempts', async (t) => {
  const cfg = config();
  cfg.review = { structuredOutput: 'tool' };
  const { env, ws } = setup(t, 'model-429', cfg, { FAKE_FAIL_MODELS: M.strong });
  fs.writeFileSync(path.join(ws, 'app.js'), 'console.log("hello");\n');
  const r = await runCli(['review', '--wait', '--json'], { env, cwd: ws });
  assert.equal(r.code, 0, output(r));
  const [job] = jobsIn(env, ws);
  assert.equal(job.attempts.length, 2);
  assert.deepEqual(JSON.parse(r.stdout).attempts, job.attempts);
  const result = await runCli(['result', job.id, '--json'], { env, cwd: ws });
  assert.equal(result.code, 0, output(result));
  assert.deepEqual(JSON.parse(result.stdout).attempts, job.attempts);
});
