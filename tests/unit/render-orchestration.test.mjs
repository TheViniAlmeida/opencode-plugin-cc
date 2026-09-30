import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrchestration } from '../../plugins/opc/scripts/lib/render.mjs';

const base = () => ({
  schemaVersion: 1, task: 'Audit   the repo', status: 'completed', outcome: 'completed', errorCode: null, errorMessage: null,
  durationMs: 12345, planner: { model: 'p/planner', status: 'completed' },
  plan: { rationale: 'Two angles.', subtasks: [] }, rawPlan: null, planErrors: [],
  subtasks: [
    { id: 'a', title: 'Find exports', kind: 'ask', tier: 'light', dependsOn: [], model: 'p/m1', status: 'completed', result: 'RESULT[a]', resultTruncated: false, errorCode: null, errorMessage: null, startedAt: 0, endedAt: 1500, touchedFiles: [], sessionID: 'ses_a' },
    { id: 'b', title: 'Review | pipes', kind: 'review', tier: null, dependsOn: ['a'], model: null, status: 'cancelled', result: null, resultTruncated: false, errorCode: 'dependency_failed', errorMessage: 'dependency "a" failed', startedAt: null, endedAt: null, touchedFiles: [], sessionID: null },
  ], synthesis: { mode: 'claude', status: 'pending', model: null, text: null, errorMessage: null, attempts: [] }, warnings: [],
});

test('renderiza cabeçalho, plano, resultados e nota de síntese do Claude', () => {
  const pkg = base(); pkg.plan.subtasks = pkg.subtasks;
  const out = renderOrchestration(pkg, { jobId: 'orch-abc' });
  assert.match(out, /^# opc orchestrate\n\nTarefa: Audit the re…\nStatus: concluída · job orch-abc · 2 subtarefas · 12\.3 s\nPlanner: p\/planner\n/);
  assert.match(out, /## Plano\n\nTwo angles\.\n/);
  assert.match(out, /\| a \| ask \| light \| p\/m1 \| concluída \| - \|/);
  assert.match(out, /\| b \| review \| - \| - \| cancelada \| a \|/);
  assert.match(out, /### a — Find exports\n\n`ask` · modelo `p\/m1` · concluída · 1\.5 s\n\nRESULT\[a\]/);
  assert.match(out, /cancelada \(dependency_failed\): dependency "a" failed/);
  assert.match(out, /## Síntese\n\nSíntese a cargo do Claude/);
  assert.ok(out.endsWith('\n'));
});

test('renderiza o texto de síntese do modelo', () => {
  const pkg = base(); pkg.plan.subtasks = pkg.subtasks;
  pkg.synthesis = { mode: 'model', status: 'completed', model: 'p/judge', text: 'SYNTHESIS-OK', errorMessage: null, attempts: [] };
  const out = renderOrchestration(pkg);
  assert.match(out, /## Síntese\n\nSintetizador: `p\/judge`\n\nSYNTHESIS-OK/);
  assert.ok(!out.includes('Síntese a cargo do Claude'));
});

test('renderiza falha de síntese do modelo e avisos em português', () => {
  const pkg = base(); pkg.plan.subtasks = pkg.subtasks; pkg.outcome = 'completed_with_warnings';
  pkg.synthesis = { mode: 'model', status: 'failed', model: 'p/judge', text: null, errorMessage: '500', attempts: [] };
  pkg.warnings = ['A síntese pelo modelo falhou (500); Claude deve sintetizar os resultados brutos'];
  const out = renderOrchestration(pkg);
  assert.match(out, /Status: concluída com avisos/);
  assert.match(out, /A síntese pelo modelo `p\/judge` falhou: 500\./);
  assert.match(out, /Síntese a cargo do Claude/);
  assert.match(out, /## Avisos\n\n- A síntese pelo modelo falhou/);
});

test('renderiza plano inválido com erros e plano bruto', () => {
  const out = renderOrchestration({ task: 't', status: 'failed', outcome: 'failed', errorCode: 'invalid_plan', errorMessage: 'invalid plan: dependency cycle: a -> b -> a', durationMs: 10, planner: { model: 'p/planner' }, plan: null, rawPlan: { rationale: 'x', subtasks: [{ id: 'a', note: '```' }] }, planErrors: ['dependency cycle: a -> b -> a'], subtasks: [], synthesis: null, warnings: [] });
  assert.match(out, /Status: falhou/);
  assert.match(out, /Erro: invalid_plan: plano inválido: ciclo de dependência/);
  assert.match(out, /## Plano inválido\n\n- ciclo de dependência: a -> b -> a/);
  assert.match(out, /### Plano bruto\n\n````json\n\{/);
});

test('renderiza saída bruta do planner quando a decomposição falha', () => {
  const out = renderOrchestration({ task: 't', status: 'failed', outcome: 'failed', errorCode: 'planner_structured_output', errorMessage: 'planner failed: schema mismatch', durationMs: 10, planner: { model: 'p/planner' }, plan: null, rawPlan: 'free text plan', planErrors: [], subtasks: [], synthesis: null, warnings: [] });
  assert.match(out, /## Saída bruta do planner\n\n```\nfree text plan\n```/);
});

test('pacote nulo renderiza aviso curto', () => assert.equal(renderOrchestration(null), '# opc orchestrate\n\nNenhum resultado registrado para este job.\n'));
