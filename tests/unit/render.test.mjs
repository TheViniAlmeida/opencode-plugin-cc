import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { renderError, renderSetup, renderTable } from '../../plugins/opc/scripts/lib/render.mjs';

const SECRET = 'render-secret-abcdef123456';
registerSecret(SECRET);

test('renderTable escapes pipes and newlines', () => {
  assert.equal(renderTable(['a', 'b'], [['x|y', 'line1\nline2']]), '| a | b |\n| --- | --- |\n| x\\|y | line1 line2 |\n');
});

test('renderTable redacts registered secrets from cells', () => {
  const out = renderTable(['value'], [[SECRET]]);
  assert.match(out, /\*\*\*/);
  assert.ok(!out.includes(SECRET));
});

test('renderTable redacts a registered secret before escaping markdown characters', () => {
  const secret = 'ab|cd1234efgh';
  registerSecret(secret);

  const out = renderTable(['value'], [[secret]]);

  assert.match(out, /\*\*\*/);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('ab\\|cd1234efgh'));
});

test('renderTable redacts a registered secret before replacing newlines', () => {
  const secret = 'abcd\nefgh1234';
  registerSecret(secret);

  const out = renderTable(['value'], [[secret]]);

  assert.match(out, /\\*\\*\\*/);
  assert.ok(!out.includes('abcd efgh1234'));
  assert.ok(!out.includes('efgh1234'));
});

test('renderError prints code and message, redacted, without stack', () => {
  const out = renderError(new ConnectionError('AUTH_FAILED', `bad ${SECRET}`));
  assert.equal(out, '# opc error\nAUTH_FAILED: bad ***\n');
  assert.equal(renderError(new Error('plain')), '# opc error\nINTERNAL: plain\n');
});

const baseReport = {
  mode: 'diagnose',
  ready: true,
  node: { ok: true, version: '22.1.0' },
  opencode: { installed: true, version: '1.18.32', supported: true },
  dataDir: '/data',
  workspaceRoot: '/ws',
  stateDir: '/data/state/ws-0123456789abcdef',
  config: { hasGlobal: false, globalPath: '/data/config.json', workspaceFound: false, workspacePath: '/ws/.opc.json', warnings: [] },
  server: { status: 'running', url: 'http://127.0.0.1:43210', pid: 99, version: '1.18.32', reused: false, sessionsBlocked: null, warnings: [] },
  terminalAlias: `alias opc='OPC_DATA_DIR="/data" node "/p/scripts/opc-companion.mjs"'`,
  nextSteps: ['Faça algo'],
};

test('renderSetup shows checks, server, alias and next steps', () => {
  const out = renderSetup(baseReport);
  assert.match(out, /^# opc setup\n/);
  assert.match(out, /Status: pronto/);
  assert.match(out, /- opencode: ok \(1\.18\.32\)/);
  assert.match(out, /- url: http:\/\/127\.0\.0\.1:43210/);
  assert.match(out, /reaproveitado: não/);
  assert.ok(out.includes(baseReport.terminalAlias));
  assert.match(out, /## Próximos passos\n\n- Faça algo/);
});

test('renderSetup identifies attached servers as external even when not reused', () => {
  const out = renderSetup({ ...baseReport, server: { ...baseReport.server, status: 'attached', reused: false } });
  assert.match(out, /modo attach \(servidor externo\)/);
  assert.match(out, /externo \(attach\)/);
  assert.doesNotMatch(out, /subiu agora/);
});

test('renderSetup gives a generic message when server error details are missing', () => {
  const out = renderSetup({ ...baseReport, server: { status: 'error' } });
  assert.match(out, /erro: desconhecido/);
  assert.doesNotMatch(out, /undefined: undefined/);
});

test('renderSetup shows errors, blocked sessions and config warnings, redacting secrets', () => {
  const out = renderSetup({
    ...baseReport,
    ready: false,
    config: { ...baseReport.config, warnings: [{ path: 'policy.approver', message: 'chave travada' }] },
    server: { status: 'error', error: { code: 'BOOT_FAILED', message: `falhou ${SECRET}` }, warnings: ['aviso x'] },
  });
  assert.match(out, /requer atenção/);
  assert.match(out, /BOOT_FAILED: falhou \*\*\*/);
  assert.match(out, /- policy\.approver: chave travada/);
  assert.match(out, /- aviso: aviso x/);
  const blocked = renderSetup({ ...baseReport, server: { ...baseReport.server, sessionsBlocked: 'share-auto' } });
  assert.match(blocked, /BLOQUEADAS \(share-auto\)/);
});

test('renderSetup renders the stop result and the active jobs table', () => {
  const out = renderSetup({ mode: 'stop', stop: { stopped: false, reason: 'active-jobs' }, activeJobs: [{ id: 'task-1', kind: 'task', status: 'running', title: 'x|y' }] });
  assert.match(out, /recusado: há jobs ativos/);
  assert.match(out, /\| task-1 \| task \| running \| x\\\|y \|/);
  assert.match(renderSetup({ mode: 'stop', stop: { stopped: true, reason: 'killed' } }), /SIGKILL/);
});
