import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { runOrchestration, RESULT_MAX_BYTES } from '../../plugins/opc/scripts/lib/orchestrator.mjs';

const cand = (full) => ({ providerID: 'p', modelID: full, full });
const sub = (id, extra = {}) => ({ id, title: `Title ${id}`, prompt: `Do ${id}`, kind: 'ask', dependsOn: [], ...extra });
const ctxOf = (extra = {}) => ({ config: { jobs: { maxParallel: 4 }, orchestrate: { maxSubtasks: 5 }, policy: {}, ...extra } });

function makeDeps({ plan, turn, routes = {}, signal } = {}) {
  const calls = [];
  const deps = {
    resolvePlanner: () => ({ candidates: [cand('PLANNER')], warnings: [], fallbackEligible: false }),
    resolveSynthesizer: () => ({ candidates: [cand('SYNTH')], warnings: [], fallbackEligible: false }),
    resolveSubtask: (s) => routes[s.id] ?? { candidates: [cand('A'), cand('B'), cand('C')], warnings: [], fallbackEligible: true },
    signal,
    runTurn: async (spec) => {
      calls.push({ ...spec, start: Date.now(), end: null });
      const result = spec.role === 'planner' ? { status: 'completed', structured: plan } : await (turn?.(spec) ?? (async () => { await sleep(5); return { status: 'completed', finalText: `RESULT[${spec.subtaskId}]` }; })());
      calls.at(-1).end = Date.now();
      return { model: spec.candidates[0].full, attempts: [], sessionID: `ses_${calls.length}`, ...result };
    },
  };
  return { deps, calls };
}

test('executa plano válido, espalha modelos e mantém síntese Claude pendente', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c', { dependsOn: ['a', 'b'] })] } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 'Audit the repo', flags: { synthesizer: 'claude' }, deps });
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.outcome, 'completed');
  assert.deepEqual(pkg.subtasks.map((s) => [s.id, s.status, s.result]), [['a', 'completed', 'RESULT[a]'], ['b', 'completed', 'RESULT[b]'], ['c', 'completed', 'RESULT[c]']]);
  assert.deepEqual(pkg.synthesis, { mode: 'claude', status: 'pending', model: null, text: null, errorMessage: null, attempts: [] });
  assert.equal(calls[0].format.schema.properties.subtasks.maxItems, 5);
  assert.equal(calls[0].profile, 'read-only');
});

test('rejeita escrita sem --write e não inicia workers', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('w', { kind: 'task' }), sub('r')] } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.errorCode, 'invalid_plan');
  assert.match(pkg.errorMessage, /sem --write/);
  assert.equal(calls.filter((x) => x.role === 'worker').length, 0);
});

test('falha cancela dependente e mantém independente', async () => {
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b', { dependsOn: ['a'] }), sub('c')] }, turn: async (spec) => spec.subtaskId === 'a' ? { status: 'failed', errorType: 'UnknownError', errorMessage: 'falhou' } : { status: 'completed', finalText: 'ok' } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.subtasks[0].errorCode, 'turn_failed');
  assert.deepEqual([pkg.subtasks[1].status, pkg.subtasks[1].errorCode], ['cancelled', 'dependency_failed']);
  assert.equal(pkg.subtasks[2].status, 'completed');
  assert.equal(pkg.outcome, 'completed_with_warnings');
});

test('síntese por modelo recebe resultados', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, turn: async (spec) => spec.role === 'synthesizer' ? { status: 'completed', finalText: 'SYNTHESIS TEXT' } : { status: 'completed', finalText: `RESULT[${spec.subtaskId}]` } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: { synthesizer: 'model' }, deps });
  assert.equal(pkg.synthesis.status, 'completed');
  assert.equal(pkg.synthesis.text, 'SYNTHESIS TEXT');
  assert.match(calls.find((x) => x.role === 'synthesizer').prompt, /<result id="a"/);
});

test('trunca saída grande e cancela por AbortSignal', async () => {
  const controller = new AbortController();
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, signal: controller.signal, turn: async (spec) => { controller.abort(); return { status: 'completed', finalText: 'x'.repeat(RESULT_MAX_BYTES * 2) }; } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.status, 'cancelled');
  assert.equal(pkg.subtasks[0].result.length, RESULT_MAX_BYTES);
  assert.equal(pkg.subtasks[0].resultTruncated, true);
});
