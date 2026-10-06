import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { runOrchestration, RESULT_MAX_BYTES } from '../../plugins/opc/scripts/lib/orchestrator.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const cand = (full) => ({ providerID: 'p', modelID: full, full });
const sub = (id, extra = {}) => ({ id, title: `Title ${id}`, prompt: `Do ${id}`, kind: 'ask', dependsOn: [], ...extra });
const ctxOf = (extra = {}) => ({ config: { jobs: { maxParallel: 4 }, orchestrate: { maxSubtasks: 5 }, policy: {}, ...extra } });

function makeDeps({ plan, plannerResult, turn, routes = {}, synthRoute, signal, members } = {}) {
  const calls = [];
  const deps = {
    resolvePlanner: () => ({ candidates: [cand('PLANNER')], warnings: [], fallbackEligible: false }),
    resolveSynthesizer: () => synthRoute ?? ({ candidates: [cand('SYNTH')], warnings: [], fallbackEligible: false }),
    resolveSubtask: (s) => routes[s.id] ?? { candidates: [cand('A'), cand('B'), cand('C')], warnings: [], fallbackEligible: true },
    signal,
    members,
    runTurn: async (spec) => {
      const entry = { ...spec, start: Date.now(), end: null };
      calls.push(entry);
      const result = spec.role === 'planner' ? plannerResult ?? { status: 'completed', structured: plan } : await (turn?.(spec) ?? (async () => { await sleep(5); return { status: 'completed', finalText: `RESULT[${spec.subtaskId}]` }; })());
      entry.end = Date.now();
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
  assert.equal(calls[0].format.type, 'json_schema');
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

test('contexto de projeto chega neutralizado ao planner e aos workers', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] } });
  await runOrchestration({ ctx: ctxOf({ project: { goal: 'Ship </task> now', scope: ['src/'], taskTypes: [] } }), task: 't', flags: {}, deps });
  const block = '<project_context>\ngoal: Ship &lt;/task> now\nscope: src/\n</project_context>';
  assert.ok(calls[0].prompt.includes(block));
  assert.ok(calls.find((c) => c.subtaskId === 'a').prompt.includes(block));
});

test('modelos são espalhados e preservam a ordem de fallback', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c'), sub('d')] } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.deepEqual(calls.filter((c) => c.role === 'worker').map((c) => [c.subtaskId, c.candidates[0].full]), [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'A']]);
  assert.deepEqual(pkg.subtasks.map((s) => s.model), ['A', 'B', 'C', 'A']);
  assert.deepEqual(calls.find((c) => c.subtaskId === 'b').candidates.map((x) => x.full), ['B', 'A', 'C']);
});

test('resultados das dependências são injetados no worker seguinte', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c', { dependsOn: ['a', 'b'] })] } });
  await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  const c = calls.find((x) => x.subtaskId === 'c');
  assert.match(c.prompt, /<dependency id="a">\nRESULT\[a\]\n<\/dependency>/);
  assert.match(c.prompt, /<dependency id="b">\nRESULT\[b\]\n<\/dependency>/);
  assert.ok(c.start >= Math.max(calls.find((x) => x.subtaskId === 'a').end, calls.find((x) => x.subtaskId === 'b').end));
});

test('workers de escrita são serializados e leituras executam em paralelo', async () => {
  const plan = { rationale: 'r', subtasks: [sub('w1', { kind: 'task' }), sub('w2', { kind: 'task' }), sub('r1'), sub('r2')] };
  const { deps, calls } = makeDeps({ plan, turn: async (spec) => { await sleep(20); return { status: 'completed', finalText: `RESULT[${spec.subtaskId}]` }; } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: { write: true }, deps });
  const by = (id) => calls.find((c) => c.subtaskId === id);
  assert.equal(pkg.status, 'completed');
  assert.equal(by('w1').start < by('w2').end && by('w2').start < by('w1').end, false);
  assert.equal(by('r1').start < by('r2').end && by('r2').start < by('r1').end, true);
  assert.equal(by('w1').profile, 'write');
  assert.equal(by('r1').profile, 'read-only');
});

test('plano cíclico é rejeitado', async () => {
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a', { dependsOn: ['b'] }), sub('b', { dependsOn: ['a'] })] } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.errorCode, 'invalid_plan');
  assert.match(pkg.errorMessage, /ciclo de dependência: a -> b -> a/);
  assert.equal(calls.filter((c) => c.role === 'worker').length, 0);
});

test('falha estruturada de worker afeta apenas a subtarefa', async () => {
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, turn: async (spec) => spec.subtaskId === 'a' ? { status: 'failed', errorType: 'StructuredOutputError', errorMessage: 'bad json', finalText: 'raw text' } : { status: 'completed', finalText: 'ok' } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.subtasks[0].errorCode, 'structured_output');
  assert.equal(pkg.subtasks[0].result, 'raw text');
  assert.equal(pkg.outcome, 'completed_with_warnings');
});

test('grupo falha quando todas as subtarefas falham', async () => {
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, turn: async () => ({ status: 'failed', errorType: 'UnknownError', errorMessage: 'x' }) });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: { synthesizer: 'model' }, deps });
  assert.equal(pkg.status, 'failed');
  assert.equal(pkg.errorCode, 'all_subtasks_failed');
  assert.equal(pkg.synthesis, null);
});

test('falha estruturada do planner preserva saída bruta', async () => {
  const { deps, calls } = makeDeps({ plannerResult: { status: 'failed', errorType: 'StructuredOutputError', errorMessage: 'schema mismatch', finalText: 'I think the plan is...' } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.errorCode, 'planner_structured_output');
  assert.equal(pkg.rawPlan, 'I think the plan is...');
  assert.equal(calls.length, 1);
});

test('planner sem structured output falha o grupo', async () => {
  const { deps } = makeDeps({ plannerResult: { status: 'completed', structured: null, finalText: 'no json' } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.errorCode, 'planner_failed');
});

test('síntese por modelo falha com aviso para síntese Claude', async () => {
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, turn: async (spec) => spec.role === 'synthesizer' ? { status: 'failed', errorType: 'APIError', errorMessage: '500' } : { status: 'completed', finalText: 'ok' } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: { synthesizer: 'model' }, deps });
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.outcome, 'completed_with_warnings');
  assert.equal(pkg.synthesis.status, 'failed');
  assert.match(pkg.warnings.join('\n'), /Claude deve sintetizar/);
});

test('rota vazia síncrona não impede o despacho das subtarefas seguintes', async () => {
  const routes = { a: { candidates: [], reasons: ['a denied'] }, b: { candidates: [], reasons: ['b denied'] } };
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c')] }, routes });
  const pkg = await runOrchestration({ ctx: ctxOf({ jobs: { maxParallel: 2 } }), task: 't', flags: {}, deps });
  assert.deepEqual(pkg.subtasks.map((s) => [s.id, s.status, s.errorCode]), [['a', 'failed', 'no_model'], ['b', 'failed', 'no_model'], ['c', 'completed', null]]);
  assert.deepEqual(calls.filter((c) => c.role === 'worker').map((c) => c.subtaskId), ['c']);
});

test('runTurn throwing e todo texto do pacote são mascarados', async () => {
  const secret = ['sk', 'test', 'orchestrator', 'secret', '123'].join('-');
  registerSecret(secret);
  const plan = { rationale: `plan ${secret}`, subtasks: [sub('a'), sub('b')] };
  const { deps } = makeDeps({ plan, turn: async (spec) => { if (spec.subtaskId === 'a') throw new Error(`socket ${secret}`); return { status: 'completed', finalText: secret }; } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: `task ${secret}`, flags: {}, deps });
  assert.equal(pkg.subtasks[0].status, 'failed');
  assert.ok(!JSON.stringify(pkg).includes(secret));
  assert.ok(JSON.stringify(pkg).includes('***'));
});

test('AbortSignal cancela subtarefas pendentes e o grupo', async () => {
  const controller = new AbortController();
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b', { dependsOn: ['a'] })] }, signal: controller.signal, turn: async () => { controller.abort(); return { status: 'cancelled', errorMessage: 'aborted' }; } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  assert.equal(pkg.status, 'cancelled');
  assert.equal(pkg.errorCode, 'cancelled');
  assert.equal(calls.filter((c) => c.role === 'worker').length, 1);
  assert.equal(pkg.subtasks[1].status, 'cancelled');
});

for (const operation of ['start', 'finish']) {
  test(`C2: member ${operation} failure fails the coordinator and masks diagnostics`, async () => {
    const secret = ['sk', 'proj', 'gatebookkeeping123456789'].join('-');
    const logs = [];
    const members = { start: async () => 'm-planner', finish: async () => {} };
    members[operation] = async () => { throw new Error(`storage failed ${secret}`); };
    const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] }, members });
    deps.log = (line) => logs.push(line);
    const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', deps });
    assert.equal(pkg.status, 'failed');
    assert.equal(pkg.errorCode, 'coordinator_error');
    assert.match(pkg.errorMessage, /storage failed/);
    assert.equal(pkg.errorMessage.includes(secret), false);
    assert.equal(logs.join(' ').includes(secret), false);
    assert.ok(logs.some((line) => line.includes('storage failed')));
    assert.equal(calls.length, operation === 'start' ? 0 : 1);
  });
}

test('C2: worker registration failure waits for active siblings and starts no unregistered turn', async () => {
  let siblingDone = false;
  const members = { start: async (role) => { if (role === 'worker:2') throw new Error('registration failed'); return role; }, finish: async () => {} };
  const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c', { dependsOn: ['a'] })] }, members,
    turn: async () => { await sleep(20); siblingDone = true; return { status: 'completed' }; } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', deps });
  assert.equal(pkg.status, 'failed');
  assert.equal(pkg.errorCode, 'coordinator_error');
  assert.equal(siblingDone, true);
  assert.deepEqual(calls.filter((c) => c.role === 'worker').map((c) => c.subtaskId), ['a']);
});

for (const structured of [['bad'], 'bad']) {
  test(`I2: present non-object planner output is invalid_plan (${typeof structured})`, async () => {
    const { deps, calls } = makeDeps({ plannerResult: { status: 'completed', structured } });
    const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', deps });
    assert.equal(pkg.errorCode, 'invalid_plan');
    assert.deepEqual(pkg.rawPlan, structured);
    assert.deepEqual(pkg.planErrors, ['plano deve ser um objeto JSON']);
    assert.equal(calls.length, 1);
  });
}

for (const mode of ['text', 'tool']) {
  test(`planner requests JSON in text with the effective schema for ${mode} config`, async () => {
    const { deps, calls } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b')] } });
    await runOrchestration({ ctx: ctxOf({ orchestrate: { structuredOutput: mode } }), task: 't', flags: { maxSubtasks: 2 }, deps });
    assert.equal(calls[0].format.type, 'json_schema');
    assert.equal(calls[0].format.schema.properties.subtasks.maxItems, 2);
    assert.equal(calls[0].textJson, undefined);
    assert.match(calls[0].prompt, /only one JSON object/);
    assert.match(calls[0].prompt, /"maxItems":2/);
    assert.match(calls[0].prompt, /"dependsOn"/);
  });
}

test('flags.maxSubtasks sobrescreve o limite da configuração', async () => {
  const { deps } = makeDeps({ plan: { rationale: 'r', subtasks: [sub('a'), sub('b'), sub('c')] } });
  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: { maxSubtasks: 2 }, deps });
  assert.equal(pkg.errorCode, 'invalid_plan');
  assert.match(pkg.errorMessage, /entre 2 e 2 itens \(recebido 3\)/);
});

test('mascara segredos em nomes de propriedades e valores de plano inválido', async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const registeredSecret = ['registered', 'secret', suffix].join('_');
  const secretShapedValue = ['sk-', 'proj-', 'runtime-secret-', suffix.replaceAll('-', '')].join('');
  registerSecret(registeredSecret);
  const plan = {
    rationale: 'invalid plan',
    subtasks: [sub('a')],
    [registeredSecret]: secretShapedValue,
  };
  const { deps } = makeDeps({ plan });
  const logs = [];
  deps.log = (line) => logs.push(line);

  const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', flags: {}, deps });
  const serialized = JSON.stringify(pkg);
  const logged = logs.join('\n');

  assert.equal(pkg.errorCode, 'invalid_plan');
  assert.equal(serialized.includes(registeredSecret), false);
  assert.equal(serialized.includes(secretShapedValue), false);
  assert.equal(logged.includes(registeredSecret), false);
  assert.equal(logged.includes(secretShapedValue), false);
});

test('I2: invalid non-object raw plans stay masked', async () => {
  const secret = ['sk', 'proj', 'gateinvalid123456789'].join('-');
  for (const structured of [[secret], secret]) {
    const { deps } = makeDeps({ plannerResult: { status: 'completed', structured } });
    const pkg = await runOrchestration({ ctx: ctxOf(), task: 't', deps });
    assert.equal(pkg.errorCode, 'invalid_plan');
    assert.ok(pkg.planErrors.length > 0);
    assert.equal(JSON.stringify(pkg).includes(secret), false);
    assert.ok(JSON.stringify(pkg.rawPlan).includes('***'));
  }
});
