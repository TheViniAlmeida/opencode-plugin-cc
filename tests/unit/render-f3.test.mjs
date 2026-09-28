import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';
import { shellQuote } from '../../plugins/opc/scripts/lib/args.mjs';
import {
  renderSessions, renderSession, renderSessionDiff, renderTodos, renderRevertPreview,
  renderPendingLines, renderGroupStatus, renderGroupResult, renderCommandResult, renderAttach,
} from '../../plugins/opc/scripts/lib/render.mjs';

test('shellQuote keeps safe tokens and quotes everything else', () => {
  assert.equal(shellQuote('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.equal(shellQuote('/tmp/a b/ç'), "'/tmp/a b/ç'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('$(touch x)'), "'$(touch x)'");
});

test('renderSessions: table with status, escaped title, empty state', () => {
  const out = renderSessions([{ id: 'ses_a', title: 'OPC: task: a | b', time: { updated: Date.UTC(2026, 8, 26, 12, 30) } }], { statusMap: { ses_a: { type: 'busy' } } });
  assert.match(out, /# Sessões OPC/);
  assert.match(out, /ses_a/);
  assert.match(out, /busy/);
  assert.match(out, /2026-09-26 12:30/);
  assert.match(out, /a \\\| b/);
  assert.match(renderSessions([]), /Nenhuma sessão encontrada/);
  assert.match(renderSessions([{ id: 'ses_a', title: 't', time: {} }], { hiddenCount: 3 }), /3 sessão\(ões\) omitida/);
});

test('renderSession: fields, revert marker and message table', () => {
  const out = renderSession(
    { id: 'ses_a', title: 'OPC: x', directory: '/ws', agent: 'build', model: { id: 'm', providerID: 'p' }, parentID: 'ses_p', time: { created: 0, updated: 0 }, revert: { messageID: 'msg_3' } },
    { status: 'idle', messages: [{ info: { id: 'msg_1', role: 'user', agent: 'build' }, parts: [{ type: 'text', text: 'hello\nworld' }] }], note: 'Nota X.' },
  );
  assert.match(out, /# Sessão ses_a/);
  assert.match(out, /Modelo: p\/m/);
  assert.match(out, /Pai: ses_p/);
  assert.match(out, /Revert ativo: a partir de msg_3/);
  assert.match(out, /opc session unrevert ses_a --confirmed-by-user/);
  assert.match(out, /msg_1/);
  assert.match(out, /hello world/);
  assert.match(out, /Nota X\./);
});

test('renderSessionDiff: small patches inline, huge ones listed but omitted, safe fences', () => {
  const small = { file: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '+has ``` fence\n' };
  const huge = { file: 'huge.txt', status: 'added', additions: 1, deletions: 0, patch: '+x\n'.repeat(200000) };
  const out = renderSessionDiff([huge, small], { maxInlineBytes: 1024 });
  assert.match(out, /a\.txt/);
  assert.match(out, /huge\.txt/);
  assert.match(out, /````diff/);
  assert.match(out, /1 arquivo\(s\) fora do diff inline/);
  assert.ok(Buffer.byteLength(out) < 4096);
  assert.match(renderSessionDiff([]), /Nenhuma alteração registrada/);
});

test('renderTodos lists status, priority and content', () => {
  const out = renderTodos([{ content: 'check alpha', status: 'completed', priority: 'high' }], { sessionID: 'ses_a' });
  assert.match(out, /ses_a/);
  assert.match(out, /completed/);
  assert.match(out, /check alpha/);
  assert.match(renderTodos([]), /Nenhum todo/);
});

test('renderRevertPreview shows files, patch and the exact confirmation command', () => {
  const out = renderRevertPreview({
    action: 'revert', sessionID: 'ses_a', messageID: 'msg_3',
    affected: [{ file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '+BETA\n' }],
    command: 'opc session revert ses_a msg_3 --confirmed-by-user',
  });
  assert.match(out, /confirmação necessária \(revert\)/);
  assert.match(out, /notes\.txt/);
  assert.match(out, /\+BETA/);
  assert.match(out, /Nada foi alterado/);
  assert.match(out, /opc session revert ses_a msg_3 --confirmed-by-user/);
  const un = renderRevertPreview({ action: 'unrevert', sessionID: 'ses_a', messageID: 'msg_3', rawDiff: '+BETA\n', command: 'opc session unrevert ses_a --confirmed-by-user' });
  assert.match(un, /unrevert/);
  assert.match(un, /\+BETA/);
  assert.match(renderRevertPreview({ action: 'revert', sessionID: 's', messageID: 'm', affected: [], command: 'c' }), /nenhuma alteração de arquivo/i);
});

test('renderPendingLines: iterates the pendingRequest list (permission and question reply lines, memberId)', () => {
  assert.deepEqual(renderPendingLines({ id: 'sub-1' }), []);
  assert.deepEqual(renderPendingLines({ id: 'sub-1', pendingRequest: [] }), []);
  const perm = renderPendingLines({ id: 'sub-1', pendingRequest: [{ type: 'permission', id: 'per_1', permission: 'bash', patterns: ['npm test'], sessionID: 'ses_c' }] });
  assert.ok(perm.some((l) => l.includes('/opc:permissions reply per_1 once')));
  assert.ok(perm.some((l) => l.includes('/opc:permissions reply per_1 reject')));
  const q = renderPendingLines({ id: 'sub-1', pendingRequest: [{ type: 'question', id: 'que_1', questions: [{ question: 'Qual?' }] }] });
  assert.ok(q.some((l) => l.includes('/opc:permissions answer que_1')));
  const both = renderPendingLines({ id: 'sub-g', pendingRequest: [
    { type: 'permission', id: 'per_2', permission: 'edit', patterns: ['a.txt'], memberId: 'sub-m2' },
    { type: 'question', id: 'que_2', questions: [], memberId: 'sub-m3' },
  ] });
  assert.ok(both.some((l) => l.startsWith('- sub-m2: permissão edit')));
  assert.ok(both.some((l) => l.startsWith('- sub-m3: pergunta que_2')));
});

const group = { id: 'sub-g', kind: 'sub', status: 'running', phase: '1/2 done', sessionID: 'ses_p', result: { counts: { completed: 1, failed: 1 }, warnings: ['1 failed, 0 cancelled'] } };
const members = [
  { id: 'sub-m1', agent: 'general', model: 'p/deepseek', status: 'completed', phase: 'completed', sessionID: 'ses_c1', result: { finalText: 'RESULT one', mechanism: 'child-session', sessionID: 'ses_c1' } },
  { id: 'sub-m2', agent: 'general', model: 'p/kimi', status: 'failed', sessionID: 'ses_c2', errorType: 'ProviderAuthError', errorMessage: 'invalid api key', result: { mechanism: 'subtask', fellBack: true } },
];

test('renderGroupStatus: member table, warnings and cancel hints', () => {
  const out = renderGroupStatus(group, members);
  assert.match(out, /# Grupo sub-g/);
  assert.match(out, /1\/2 done/);
  assert.match(out, /sub-m1/);
  assert.match(out, /p\/kimi/);
  assert.match(out, /Avisos: 1 failed/);
  assert.match(out, /\/opc:cancel sub-g/);
  assert.match(out, /\/opc:status sub-g --wait/);
});

test('renderGroupStatus displays requires-user for a pending permission', () => {
  const out = renderGroupStatus(group, [{ ...members[0], status: 'waiting_permission', pendingRequest: [
    { type: 'permission', id: 'per_sensitive', permission: 'bash', patterns: ['rm -rf build'], requiresUser: true },
  ] }]);
  assert.match(out, /- Exige o usuário: sim \(comando destrutivo, diretório externo ou caminho sensível\)/);
});

test('F3 renderers redact registered secrets and pattern tokens from patches and model results', () => {
  const registered = 'fake-render-secret-value';
  const patterned = `sk-${'a'.repeat(24)}`;
  registerSecret(registered);
  const patch = `+patch ${registered} ${patterned}`;
  const diff = renderSessionDiff([{ file: 'secret.txt', status: 'modified', patch }]);
  assert.ok(!diff.includes(registered));
  assert.ok(!diff.includes(patterned));

  const groupResult = renderGroupResult({ ...group, status: 'completed' }, [{ ...members[0], result: { finalText: `group ${registered} ${patterned}` } }]);
  assert.ok(!groupResult.includes(registered));
  assert.ok(!groupResult.includes(patterned));

  const commandResult = renderCommandResult({ command: 'echo', arguments: '', sessionID: 'ses_a', model: 'p/m', agent: null, finalText: `command ${registered} ${patterned}` });
  assert.ok(!commandResult.includes(registered));
  assert.ok(!commandResult.includes(patterned));
});

test('renderGroupResult: one section per member with text or error', () => {
  const out = renderGroupResult({ ...group, status: 'completed' }, members);
  assert.match(out, /## #1 general · p\/deepseek — completed/);
  assert.match(out, /RESULT one/);
  assert.match(out, /Erro: ProviderAuthError: invalid api key/);
  assert.match(out, /fallback de child-session/);
});

test('renderCommandResult: text or error', () => {
  assert.match(renderCommandResult({ command: 'echo', arguments: '', sessionID: 'ses_a', model: 'p/m', agent: null, finalText: 'OK' }), /Argumentos: \(nenhum\)[\s\S]*OK/);
  assert.match(renderCommandResult({ command: 'echo', arguments: 'x', sessionID: 'ses_a', model: 'p/m', error: { name: 'ProviderAuthError', data: { message: 'bad' } } }), /Erro: ProviderAuthError: bad/);
});

test('renderAttach: command reads the password from file or env, never inline', () => {
  const file = renderAttach({ url: 'http://127.0.0.1:4100', sessionID: 'ses_a', directory: '/tmp/a b', attached: false, credential: { type: 'file', path: '/data/state/x/attach.secret' } });
  assert.match(file, /OPENCODE_SERVER_PASSWORD="\$\(cat \/data\/state\/x\/attach\.secret\)" opencode attach http:\/\/127\.0\.0\.1:4100 -s ses_a --dir '\/tmp\/a b'/);
  assert.match(file, /\/opc:attach --pane ses_a/);
  const env = renderAttach({ url: 'http://127.0.0.1:4100', sessionID: null, directory: '/ws', attached: true, credential: { type: 'env', name: 'OPC_SERVER_PASSWORD' } });
  assert.match(env, /OPENCODE_SERVER_PASSWORD="\$OPC_SERVER_PASSWORD" opencode attach http:\/\/127\.0\.0\.1:4100 --dir \/ws/);
  assert.match(env, /externo/);
  assert.match(renderAttach({ url: 'u', sessionID: 'ses_a', directory: '/ws', attached: false, credential: { type: 'file', path: '/p' }, pane: { id: '%42' } }), /Pane aberto: %42/);
});
