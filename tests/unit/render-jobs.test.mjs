import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration, renderCancel, renderJobStatus, renderPermissionList, renderPermissionRequest, renderQueuedJob, renderStatusList, renderTable, renderTurnResult,
} from '../../plugins/opc/scripts/lib/render.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const job = (over = {}) => ({
  id: 'task-abc-123456', kind: 'task', status: 'running', phase: 'editing', model: 'p/m', permissionProfile: 'write',
  sessionID: 'ses_1', summary: 'corrigir o erro', createdAt: '2026-09-26T10:00:00.000Z', startedAt: '2026-09-26T10:00:00.000Z',
  childSessionIDs: [], logFile: '/state/jobs/task-abc-123456.log', ...over,
});

test('formatDuration', () => {
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T10:00:42Z'), '42s');
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T10:03:05Z'), '3m 5s');
  assert.equal(formatDuration('2026-09-26T10:00:00Z', '2026-09-26T12:10:00Z'), '2h 10m');
  assert.equal(formatDuration(null), '');
});

test('renderJobStatus: job ativo mostra tempo, progresso e cancelamento', () => {
  const out = renderJobStatus(job(), { progress: ['leitura: a.js', 'edição: b.js'], now: Date.parse('2026-09-26T10:01:00Z') });
  assert.match(out, /Status: running \(phase: editing\)/);
  assert.match(out, /Decorrido: 1m 0s/);
  assert.match(out, /Progresso:\n  leitura: a\.js\n  edição: b\.js/);
  assert.match(out, /\/opc:cancel task-abc-123456/);
  assert.doesNotMatch(out, /\/opc:result/);
});

test('renderJobStatus: job com falha mostra erro e dica para retomar', () => {
  const out = renderJobStatus(job({ status: 'failed', phase: 'failed', errorType: 'ServerLost', errorClass: 'fatal', errorMessage: 'perdeu conexão', completedAt: '2026-09-26T10:00:30.000Z' }));
  assert.match(out, /Erro: ServerLost \(fatal\): perdeu conexão/);
  assert.match(out, /Duração: 30s/);
  assert.match(out, /\/opc:task --resume task-abc-123456/);
});

test('renderStatusList: até 8 recentes, tabela ativa e 4 linhas de progresso', () => {
  const jobs = [job({ id: 'task-a-000001' }), ...Array.from({ length: 12 }, (_, i) => job({ id: `task-b-${String(i).padStart(6, '0')}`, status: 'completed', completedAt: '2026-09-26T10:00:10.000Z' }))];
  const out = renderStatusList(jobs, { progressById: { 'task-a-000001': ['1', '2', '3', '4', '5', '6'] } });
  assert.match(out, /Jobs ativos:/);
  assert.equal((out.match(/\/opc:result task-b-/g) ?? []).length, 8);
  assert.match(out, /- task-a-000001\n    3\n    4\n    5\n    6/);
  assert.equal(renderStatusList([]), '# opc status\n\nNenhum job registrado ainda.\n');
  const all = renderStatusList(jobs, { maxJobs: Infinity });
  assert.equal((all.match(/\/opc:result task-b-/g) ?? []).length, 12);
});

test('renderTurnResult: texto concluído, estrutura, arquivos alterados e retomada', () => {
  const out = renderTurnResult(job({ status: 'completed', result: { finalText: 'Tudo certo', structured: { ok: true }, touchedFiles: ['a.js'] } }));
  assert.match(out, /^Tudo certo\n\nSaída estruturada:\n```json\n\{\n  "ok": true\n\}\n```/);
  assert.match(out, /Arquivos alterados: a\.js/);
  assert.match(out, /Continuar: \/opc:task --resume task-abc-123456/);
});

test('renderTurnResult: erro de estrutura mostra texto bruto; server_lost oferece retomada', () => {
  const s = renderTurnResult(job({ status: 'failed', errorType: 'StructuredOutputError', errorClass: 'recoverable', errorMessage: 'JSON inválido', result: { finalText: 'texto bruto' } }));
  assert.match(s, /Saída bruta \(falha na saída estruturada\):\n\ntexto bruto/);
  const l = renderTurnResult(job({ kind: 'ask', status: 'failed', errorType: 'ServerLost', errorCode: 'server_lost', errorMessage: 'conexão perdida', result: {} }));
  assert.match(l, /Continue com: \/opc:ask --resume task-abc-123456/);
});

test('renderTurnResult preserva texto final maior que 1 MB', () => {
  const text = 'z'.repeat(1_200_000);
  const out = renderTurnResult(job({ status: 'completed', result: { finalText: text } }));
  assert.ok(out.includes(text));
});

test('renderPermissionRequest: respostas prontas, sessão filha, sinalização e cerca segura', () => {
  const out = renderPermissionRequest(job({
    status: 'waiting_permission',
    pendingRequest: [
      { type: 'permission', id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf build ```'], requiresUser: true },
      { type: 'question', id: 'que_1', sessionID: 'ses_1', questions: [{ header: 'DB', question: 'Qual?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, { header: 'F', question: 'Recursos?', options: [{ label: 'A' }], multiple: true }] },
    ],
  }), { timeoutSec: 600 });
  assert.match(out, /\/opc:permissions reply per_1 once/);
  assert.match(out, /\/opc:permissions reply per_1 reject "<reason>"/);
  assert.match(out, /Sessão: ses_child \(sessão filha\)/);
  assert.match(out, /Exige o usuário: sim/);
  assert.match(out, /````text\nrm -rf build ```\n````/);
  assert.match(out, /\/opc:permissions answer que_1 "<answer 1>" "<answer 2>"/);
  assert.match(out, /Opções: Postgres \| SQLite/);
  assert.match(out, /\/opc:status task-abc-123456 --wait/);
  assert.match(out, /após 600 s/);
});

test('renderQueuedJob, renderCancel e renderPermissionList', () => {
  assert.match(renderQueuedJob(job({ status: 'queued' })), /na fila em segundo plano \(task, p\/m\)/);
  assert.match(renderCancel(job(), { aborted: true, idle: true, worker: 'exited' }), /Cancelada task-abc-123456/);
  const list = renderPermissionList([{ type: 'permission', id: 'per_9', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'] }], [job()]);
  assert.match(list, /\| per_9 \| permission \| bash: ls \| ses_1 \| task-abc-123456 \|/);
  assert.match(renderPermissionList([]), /Nenhuma solicitação pendente/);
});

test('todos os oito renderizadores F2a redigem o texto final', () => {
  const secret = 'renderer-secret-123456789';
  registerSecret(secret);
  const outputs = [
    renderTable(['header'], [[secret]]),
    renderJobStatus(job({ status: 'failed', phase: 'failed', summary: 'safe summary', errorMessage: secret })),
    renderStatusList([job({ summary: secret })]),
    renderTurnResult(job({ status: 'completed', result: { finalText: secret } })),
    renderPermissionRequest(job({ pendingRequest: [
      { type: 'permission', id: 'p', permission: 'bash', patterns: ['safe pattern'] },
      { type: 'question', id: 'q', questions: [{ header: 'safe header', question: secret, options: [{ label: secret }] }] },
    ] })),
    renderQueuedJob(job({ id: secret })),
    renderCancel(job({ id: secret }), { aborted: true, idle: true, worker: secret }),
    renderPermissionList([{ type: 'permission', id: 'p', permission: 'bash', patterns: [secret], sessionID: 'ses_1' }]),
  ];
  for (const output of outputs) assert.ok(!output.includes(secret), 'renderer output must not contain the registered secret');
});
