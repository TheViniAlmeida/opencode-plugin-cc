import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderReview,
  renderReviewEstimate,
  renderReviewGate,
  renderReviewJob,
  reviewMetaFromJob,
  validateReviewOutput,
} from '../../plugins/opc/scripts/lib/render.mjs';

const VALID = {
  verdict: 'needs-attention', summary: 'Um bug bloqueante.',
  findings: [
    { severity: 'low', title: 'Nome menor', body: 'Detalhe baixo.', file: 'src/a.js', line_start: 3, line_end: 3, confidence: 0.4, recommendation: '' },
    { severity: 'critical', title: 'Falha com entrada vazia', body: 'Linha um.\nLinha dois.', file: 'src/app.js', line_start: 10, line_end: 12, confidence: 0.9, recommendation: 'Proteja o caso vazio.' },
    { severity: 'medium', title: 'Loop lento', body: 'Detalhe médio.', file: 'src/b.js', line_start: 5, line_end: 9, confidence: 0.6, recommendation: 'Armazene o valor em cache.' },
    { severity: 'high', title: 'Condição de corrida', body: 'Detalhe alto.', file: 'src/c.js', line_start: 1, line_end: 2, confidence: 0.7, recommendation: 'Use um lock.' },
  ], next_steps: ['Corrija a falha.'],
};

test('renderReview orders findings by severity and prints file line ranges', () => {
  const out = renderReview({ status: 'completed', structured: VALID }, { variant: 'review', targetLabel: 'diff da árvore de trabalho', model: 'p/m', jobId: 'review-1' });
  assert.match(out, /^# OPC Revisão\n\nAlvo: diff da árvore de trabalho\nModelo: p\/m\nJob: review-1\n\nVeredito: needs-attention\n\nUm bug bloqueante\./);
  const order = ['[critical]', '[high]', '[medium]', '[low]'].map((tag) => out.indexOf(tag));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index > 0));
  assert.match(out, /- \[critical\] Falha com entrada vazia \(src\/app\.js:10-12\)\n  Linha um\.\n  Linha dois\.\n  Recomendação: Proteja o caso vazio\./);
  assert.match(out, /- \[low\] Nome menor \(src\/a\.js:3\)\n  Detalhe baixo\.\n(?!  Recomendação)/);
  assert.match(out, /Próximos passos:\n- Corrija a falha\.\n$/);
});

test('renderReview reports no material findings for an empty list', () => {
  const out = renderReview({ status: 'completed', structured: { verdict: 'approve', summary: 'Parece bom.', findings: [], next_steps: [] } }, { variant: 'adversarial' });
  assert.match(out, /^# OPC Revisão Adversarial\n/);
  assert.match(out, /Veredito: approve\n\nParece bom\.\n\nNenhum achado relevante\.\n$/);
});

test('renderReview degrades to raw text on StructuredOutputError', () => {
  const out = renderReview({ status: 'failed', errorType: 'StructuredOutputError', errorMessage: 'sem chamada de ferramenta', structured: null, finalText: 'RAW ```fenced``` TEXT' });
  assert.match(out, /O OpenCode não retornou uma saída estruturada válida\./);
  assert.match(out, /- Erro: sem chamada de ferramenta/);
  assert.match(out, /````text\nRAW ```fenced``` TEXT\n````/);
});

test('renderReview reports invalid structured output and shows raw JSON', () => {
  const out = renderReview({ status: 'completed', structured: { foo: 1 } });
  assert.match(out, /não retornou uma saída estruturada válida/);
  assert.match(out, /- Erro de validação: O campo `verdict` deve ser "approve" ou "needs-attention"\./);
  assert.match(out, /```json\n\{\n  "foo": 1\n\}\n```/);
});

test('renderReview reports failures and cancellations', () => {
  assert.match(renderReview({ status: 'failed', errorType: 'ProviderAuthError', errorMessage: 'chave inválida' }), /Falha na revisão: ProviderAuthError: chave inválida/);
  assert.match(renderReview({ status: 'cancelled' }), /Revisão cancelada\./);
  assert.match(renderReview({ status: 'cancelled', errorType: 'Cancelled', errorCode: 'cancelled', errorClass: 'fatal', errorMessage: 'Cancelada pelo usuário.' }), /Revisão cancelada: Cancelled \(cancelled; fatal\): Cancelada pelo usuário\./);
});

test('validateReviewOutput enforces the review output schema', () => {
  assert.equal(validateReviewOutput(VALID), null);
  assert.match(validateReviewOutput({ ...VALID, verdict: 'ok' }), /verdict/);
  assert.match(validateReviewOutput({ ...VALID, extra: 1 }), /inesperado/);
  const bad = (patch) => ({ ...VALID, findings: [{ ...VALID.findings[0], ...patch }] });
  assert.match(validateReviewOutput(bad({ severity: '' })), /severity/);
  assert.match(validateReviewOutput(bad({ confidence: 1.5 })), /confidence/);
  assert.match(validateReviewOutput(bad({ line_start: 0 })), /line_start/);
  assert.match(validateReviewOutput(bad({ file: '' })), /file/);
  assert.match(validateReviewOutput({ ...VALID, next_steps: [''] }), /next_steps\[0\]/);
  assert.match(validateReviewOutput([]), /objeto JSON no nível superior/);
});

test('reviewMetaFromJob reads review metadata stored in the request', () => {
  assert.deepEqual(reviewMetaFromJob({ id: 'review-1', model: 'x', request: { modelFull: 'p/m', review: { variant: 'adversarial', targetLabel: 'diff da branch contra main' } } }),
    { variant: 'adversarial', targetLabel: 'diff da branch contra main', model: 'p/m', jobId: 'review-1' });
  assert.deepEqual(reviewMetaFromJob({}), { variant: 'review', targetLabel: null, model: null, jobId: null });
});

test('renderReviewJob combines status, stored result, and metadata', () => {
  const request = { modelFull: 'p/m', review: { variant: 'review', targetLabel: 'diff da árvore de trabalho' } };
  assert.match(renderReviewJob({ id: 'review-1', status: 'completed', request, result: { status: 'completed', structured: VALID } }), /Job: review-1\n\nVeredito: needs-attention/);
  assert.match(renderReviewJob({ id: 'review-2', status: 'cancelled', request, result: { status: 'failed' } }), /Revisão cancelada\./);
  assert.match(renderReviewJob({ id: 'review-3', status: 'failed', errorType: 'ServerLost', errorMessage: 'servidor indisponível', request }), /Falha na revisão: ServerLost: servidor indisponível/);
});

test('renderReviewEstimate and renderReviewGate print compact lines', () => {
  assert.equal(renderReviewEstimate({ target: { label: 'diff da árvore de trabalho' }, files: 2, insertions: 10, deletions: 1, recommendation: 'aguardar' }),
    '# Estimativa de revisão OPC\n\nAlvo: diff da árvore de trabalho\nArquivos: 2 (+10 -1)\nRecomendação: aguardar\n');
  assert.equal(renderReviewGate({ enabled: true, changed: true }), 'Gate de parada: ativado (atualizado)\n');
  assert.equal(renderReviewGate({ enabled: false, changed: false }), 'Gate de parada: desativado\n');
});

test('renderReview degrades invalid findings and missing verdict to raw structured output', () => {
  for (const structured of [
    { ...VALID, findings: [{}] },
    { ...VALID, verdict: undefined },
  ]) {
    const out = renderReview({ status: 'completed', structured, finalText: 'texto bruto' });
    assert.match(out, /não retornou uma saída estruturada válida/);
    assert.match(out, /Saída estruturada bruta:/);
    assert.doesNotMatch(out, /- \[(?:critical|high|medium|low)\]/);
  }
});

test('renderReview shows failure status before valid partial structured data', () => {
  const out = renderReview({
    status: 'failed', errorCode: 'CALLBACK_FAILED', errorClass: 'fatal', errorType: 'CallbackFailed',
    errorMessage: 'O callback falhou.', structured: { ...VALID, verdict: 'approve' },
  });
  assert.match(out, /Falha na revisão: CallbackFailed \(CALLBACK_FAILED; fatal\): O callback falhou\./);
  assert.match(out, /Dados parciais:/);
  assert.doesNotMatch(out, /^Veredito: approve$/m);
});

test('renderReview treats StructuredOutputError with structured approval as a failure', () => {
  const out = renderReview({
    status: 'completed', errorName: 'StructuredOutputError',
    structured: { ...VALID, verdict: 'approve' },
  });
  assert.match(out, /Falha na revisão: StructuredOutputError/);
  assert.match(out, /Dados parciais:/);
  assert.doesNotMatch(out, /^Veredito: approve$/m);
});

test('renderReview preserves invalid structured data on callback failure', () => {
  const structured = { ...VALID, findings: [{}], extraText: '```' };
  const out = renderReview({
    status: 'failed', errorType: 'CallbackFailed', structured,
  });
  assert.match(out, /O OpenCode não retornou uma saída estruturada válida\./);
  assert.match(out, /Erro de validação: findings\[0\]: `severity`/);
  assert.match(out, /Saída estruturada bruta:/);
  assert.match(out, /````json\n[\s\S]*"extraText": "```"[\s\S]*\n````/);
  assert.ok(out.includes(JSON.stringify(structured, null, 2)));
});

test('renderReview rejects unknown severities instead of sorting them', () => {
  const structured = {
    ...VALID,
    findings: [
      { ...VALID.findings[0], severity: 'high', title: 'High first' },
      { ...VALID.findings[0], severity: 'mystery', title: 'Unknown first' },
      { ...VALID.findings[0], severity: 'high', title: 'High second' },
      { ...VALID.findings[0], severity: 'other', title: 'Unknown second' },
    ],
  };
  const out = renderReview({ status: 'completed', structured });
  assert.match(validateReviewOutput(structured), /severity/);
  assert.match(out, /não retornou uma saída estruturada válida/);

});
