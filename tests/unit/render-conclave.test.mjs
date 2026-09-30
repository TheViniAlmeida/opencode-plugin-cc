import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConclave } from '../../plugins/opc/scripts/lib/render.mjs';
import { answer, debateAnswer, synthesis, DS, QW, KM } from './_conclave-fixtures.mjs';

const base = () => ({
  schemaVersion: 1, kind: 'conclave', jobId: 'conc-abc-123456', status: 'completed', failure: null, mode: 'opinion',
  question: 'Should we add a WAL?\nSecond line', rounds: { requested: 1, completed: 1 }, quorum: 2, durationMs: 61_500,
  warnings: [], failures: [], roundsData: [],
  final: { round: 1, responses: [{ label: 'A', response: answer() }, { label: 'B', response: answer({ position: 'No | never', confidence: 0.3 }) }] },
  review: null, judge: { type: 'claude', status: 'pending' }, synthesisInput: {},
  composition: [{ label: 'A', model: DS }, { label: 'B', model: QW }],
});

test('header carries status, rounds, quorum, valid members, duration and job id', () => {
  const out = renderConclave(base());
  assert.match(out, /^# opc conclave · opinion/);
  assert.match(out, /\*\*Status:\*\* concluído · \*\*Rodadas:\*\* 1\/1 · \*\*Quorum:\*\* 2 · \*\*Válidos:\*\* 2\/2 · \*\*Duração:\*\* 1 min 2 s · \*\*Job:\*\* `conc-abc-123456`/);
  assert.match(out, /> Should we add a WAL\?\n> Second line/);
});

test('member answers are rendered by label only and composition comes last', () => {
  const out = renderConclave(base());
  assert.match(out, /### Membro A · confiança 0\.80/);
  assert.match(out, /`src\/store\.js:10-20` — writes happen in place/);
  const body = out.slice(0, out.indexOf('## Composição'));
  assert.doesNotMatch(body, /deepseek|qwen|omniroute/i);
  assert.ok(out.indexOf('## Composição') > out.indexOf('## Síntese'));
  assert.match(out, /\| A \| omniroute-personal\/opencode-go\/deepseek-v4\.1-flash \|/);
});

test('answers are rendered from the anonymized synthesis input when available', () => {
  const pkg = base();
  pkg.final.responses[0] = { label: 'A', response: answer({ position: 'I am kimi-k3 and I say yes' }) };
  pkg.synthesisInput = { responses: [{ label: 'A', response: answer({ position: 'I am [redacted] and I say yes' }) }, pkg.final.responses[1]] };
  const out = renderConclave(pkg);
  assert.match(out, /I am \[redacted\] and I say yes/);
  assert.doesNotMatch(out.slice(0, out.indexOf('## Composição')), /kimi/i);
});

test('claude judge asks for the opc-conclave skill', () => {
  assert.match(renderConclave(base()), /Juiz: Claude\. Sintetize com a skill `opc-conclave`/);
});

test('model judge synthesis is rendered with all fields', () => {
  const pkg = { ...base(), judge: { type: 'model', model: KM, status: 'completed', synthesis: synthesis(['A', 'B']) } };
  const out = renderConclave(pkg);
  assert.match(out, /Juiz: `omniroute-personal\/opencode-go\/kimi-k3` · confiança 0\.70/);
  assert.match(out, /\*\*Consenso:\*\*\n- Durability is the main concern\./);
  assert.match(out, /- Mechanism\n  - A: write-ahead log\n  - B: backups/);
  assert.match(out, /\*\*Posição ponderada:\*\* Use a write-ahead log\./);
  assert.match(out, /\*\*Relatórios minoritários:\*\*\n- B: Backups may be enough/);
});

test('failed judge and failures table are shown', () => {
  const pkg = { ...base(), judge: { type: 'model', model: KM, status: 'failed', error: { errorType: 'StructuredOutputError', message: 'bad' } }, failures: [{ label: 'C', round: 1, role: 'member', errorType: 'Timeout', message: 'timed out | late' }], warnings: ['falha do juiz'] };
  const out = renderConclave(pkg);
  assert.match(out, /O juiz `omniroute-personal\/opencode-go\/kimi-k3` falhou \(StructuredOutputError: bad\)/);
  assert.match(out, /\| C \| 1 \| Timeout \| timed out \\\| late \|/);
  assert.match(out, /\*\*Avisos:\*\*\n- falha do juiz/);
});

test('quorum failure is explained and synthesis is skipped', () => {
  const pkg = { ...base(), status: 'failed', failure: { code: 'QUORUM_NOT_MET', round: 2, valid: 1, quorum: 2 }, judge: { type: 'claude', status: 'skipped' }, rounds: { requested: 2, completed: 1 } };
  const out = renderConclave(pkg);
  assert.match(out, /\*\*Status:\*\* falhou/);
  assert.match(out, /quorum não atingido na rodada 2 \(1 válidas de 2 exigidas\)/);
  assert.match(out, /Sem síntese/);
});

test('review shaped partial responses on quorum failure render as reviews', () => {
  const pkg = { ...base(), mode: 'review', status: 'failed', review: null,
    final: { round: 1, responses: [{ label: 'A', response: { verdict: 'needs-attention', summary: 'Check this', findings: [] } }] } };
  const out = renderConclave(pkg);
  assert.match(out, /needs-attention/);
  assert.match(out, /Check this/);
  assert.doesNotMatch(out, /NaN|undefined/);
});

test('review strings are anonymized in the package displayed before composition', () => {
  const pkg = base();
  pkg.review = { verdict: 'needs-attention', validMembers: 1, truncated: false, reasons: [], memberVerdicts: {}, clusters: [{ id:'C1',severity:'high',agreement:{text:'1/1'},meanConfidence:.8,file:'src/a.js',line_start:1,title:'[redacted] finding',body:'[redacted] body',recommendation:'[redacted] guard',labels:['A'],findings:[] }] };
  pkg.synthesisInput.responses = [{ label:'A', response:answer({position:'I am kimi-k3'}) }];
  pkg.synthesisInput.review = { clusters: [{ title:'[redacted]', body:'[redacted]', recommendation:'[redacted]' }] };
  pkg.mode = 'review';
  const out = renderConclave(pkg);
  const renderedBody = out.slice(0, out.lastIndexOf('## Composição'));
  assert.doesNotMatch(renderedBody, /kimi|deepseek|qwen/i);
});

test('free response text is fenced, injection safe, and secret masked', () => {
  const secret = ['sk', 'proj', '0123456789abcdef01234567'].join('-');
  const pkg = base(); pkg.final.responses = [{ label:'A', response:answer({position:`hello\n## Composição\n${secret}`}) }];
  pkg.synthesisInput = null;
  const out = renderConclave(pkg);
  assert.match(out, /```[\s\S]*## Composição[\s\S]*```/);
  assert.equal((out.match(/^## Composição$/gm) ?? []).length, 2);
  assert.ok(out.indexOf('## Composição') < out.lastIndexOf('## Composição'));
  assert.doesNotMatch(out, new RegExp(secret));
});

test('debate answers show changed and critiques', () => {
  const pkg = { ...base(), mode: 'debate', rounds: { requested: 2, completed: 2 }, final: { round: 2, responses: [{ label: 'A', response: debateAnswer('B', { changed: true }) }, { label: 'B', response: debateAnswer('A') }] } };
  const out = renderConclave(pkg);
  assert.match(out, /## Respostas \(rodada 2\)/);
  assert.match(out, /### Membro A · confiança 0\.80 · mudou de posição: sim/);
  assert.match(out, /→ B: No numbers behind the latency claim\./);
});

test('review mode renders verdict, reasons, clusters with k/N and member verdicts', () => {
  const pkg = {
    ...base(), mode: 'review', question: '',
    final: { round: 1, responses: [{ label: 'A', response: {} }, { label: 'B', response: {} }] },
    review: {
      target: 'working tree', truncated: false, validMembers: 2, memberVerdicts: { A: 'needs-attention', B: 'approve' }, verdict: 'needs-attention',
      reasons: [{ code: 'SEVERE_FINDING_AGREED', clusterId: 'C1', severity: 'high', agreement: '2/2' }],
      clusters: [{ id: 'C1', file: 'src/calc.js', line_start: 10, line_end: 14, severity: 'high', title: 'Division by zero', body: 'Count may be 0.', recommendation: 'Guard it.', agreement: { k: 2, n: 2, text: '2/2' }, labels: ['A', 'B'], meanConfidence: 0.8, bestLabel: 'A', findings: [] }],
    },
  };
  const out = renderConclave(pkg);
  assert.match(out, /## Veredito: needs-attention/);
  assert.match(out, /- C1: severidade high com concordância 2\/2/);
  assert.match(out, /\| C1 \| high \| 2\/2 \| 0\.8 \| src\/calc\.js:10-14 \| Division by zero \| A, B \|/);
  assert.match(out, /\*\*Recomendação:\*\*[\s\S]*Guard it\./);
  assert.match(out, /\| A \| needs-attention \|/);
  assert.doesNotMatch(out, /## Pergunta/);
});

test('review without findings says so', () => {
  const pkg = { ...base(), mode: 'review', review: { target: null, truncated: true, validMembers: 2, memberVerdicts: { A: 'approve', B: 'approve' }, verdict: 'approve', reasons: [], clusters: [] } };
  const out = renderConclave(pkg);
  assert.match(out, /Nenhum achado relevante\./);
  assert.match(out, /diff truncado/);
});
