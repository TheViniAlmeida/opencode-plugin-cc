import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMonitor, formatElapsed, MONITOR_ACTIVE } from '../../plugins/opc/scripts/lib/render.mjs';
import { ACTIVE_JOB_STATUSES } from '../../plugins/opc/scripts/lib/state.mjs';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'ask-1', kind: 'ask', title: null, status: 'running', phase: 'running', model: 'p/a',
    groupId: null, role: null, createdAt: null, startedAt: null, completedAt: null,
    errorType: null, errorMessage: null, attempts: [], attempt: { current: 1, limit: 1 }, pending: [], log: [],
    ...overrides,
  };
}

test('MONITOR_ACTIVE is the canonical ACTIVE_JOB_STATUSES list', () => {
  assert.equal(MONITOR_ACTIVE, ACTIVE_JOB_STATUSES);
  assert.deepEqual([...MONITOR_ACTIVE], ['queued', 'running', 'waiting_permission']);
});

test('formatElapsed formats mm:ss and h:mm:ss and clamps negatives', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(65_000), '01:05');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
  assert.equal(formatElapsed(-5), '00:00');
});

test('empty snapshot shows the header and the empty-state line without ANSI', () => {
  const text = renderMonitor({ now: NOW, jobs: [], focus: null });
  assert.match(text, /^opc monitor — 2026-09-26 12:00:00 — 0 ativo\(s\), 0 recente\(s\) — Ctrl\+C para sair\n/);
  assert.match(text, /Nenhum job neste workspace\./);
  assert.doesNotMatch(text, /\x1b\[/);
});

test('job line shows status icon, id, status, phase, model, attempt and elapsed', () => {
  const job = entry({
    id: 'task-abc', title: 'OPC: tarefa: corrigir', status: 'waiting_permission', phase: 'editing', model: 'p/b',
    attempt: { current: 2, limit: 3 }, startedAt: '2026-09-26T11:58:55.000Z',
    pending: [{ id: 'per_9', kind: 'permission', what: 'bash', patterns: ['rm -rf dist'] }],
    log: ['fallback: APIError em p/a; próximo p/b em 2s'],
  });
  const text = renderMonitor({ now: NOW, jobs: [job], focus: null });
  assert.match(text, /1 ativo\(s\), 0 recente\(s\)/);
  assert.match(text, /⏸ task-abc {2}waiting_permission {2}editing {2}p\/b {2}tentativa 2\/3 {2}01:05/);
  assert.match(text, /\n {4}OPC: tarefa: corrigir\n/);
  assert.match(text, /⏸ permissão per_9: bash \[rm -rf dist\] → \/opc:permissions reply per_9 once\|reject/);
  assert.match(text, /│ fallback: APIError em p\/a/);
});

test('pending question shows the answer command', () => {
  const job = entry({ status: 'waiting_permission', pending: [{ id: 'que_1', kind: 'question', what: 'Qual banco?', patterns: [] }] });
  assert.match(renderMonitor({ now: NOW, jobs: [job], focus: null }), /⏸ pergunta que_1: Qual banco\? → \/opc:permissions answer que_1 <resposta>/);
});

test('focused job lists its attempts', () => {
  const job = entry({ id: 'ask-f', attempts: [{ model: 'p/a', status: 'failed', errorClass: 'recoverable', errorType: 'APIError' }, { model: 'p/b', status: 'completed' }] });
  const text = renderMonitor({ now: NOW, jobs: [job], focus: 'ask-f' });
  assert.match(text, /tentativas:\n {6}1\. p\/a — failed \(recoverable APIError\)\n {6}2\. p\/b — completed/);
  assert.doesNotMatch(renderMonitor({ now: NOW, jobs: [job], focus: null }), /tentativas:/);
});

test('failed job shows its error, terminal elapsed uses completedAt, colors when enabled', () => {
  const job = entry({ id: 'ask-x', status: 'failed', errorType: 'ProviderAuthError', errorMessage: 'credencial inválida', createdAt: '2026-09-26T11:59:00.000Z', completedAt: '2026-09-26T11:59:30.000Z' });
  const text = renderMonitor({ now: NOW, jobs: [job], focus: null }, { color: true });
  assert.match(text, /erro: ProviderAuthError: credencial inválida/);
  assert.match(text, /00:30/);
  assert.match(text, /\x1b\[31m/);
  assert.match(text, /0 ativo\(s\), 1 recente\(s\)/);
});

test('unknown timestamps render as --:-- and group members are indented', () => {
  const jobs = [entry({ id: 'sub-g' }), entry({ id: 'sub-m1', groupId: 'sub-g' })];
  const text = renderMonitor({ now: NOW, jobs, focus: null });
  assert.match(text, /● sub-g .* --:--/);
  assert.match(text, /\n {2}● sub-m1/);
});
