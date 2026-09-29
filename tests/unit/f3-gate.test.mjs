import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { registerSecret, redactTurnOutput } from '../../plugins/opc/scripts/lib/redact.mjs';
import { renderSession, renderSessions, renderTodos, renderSessionDiff, renderRevertPreview } from '../../plugins/opc/scripts/lib/render.mjs';
import { createGroup, readJob, cancelJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { runWorker } from '../../plugins/opc/scripts/commands/subagent.mjs';
import { run as result } from '../../plugins/opc/scripts/commands/result.mjs';
import { run as status } from '../../plugins/opc/scripts/commands/status.mjs';
import { collectAffectedDiff } from '../../plugins/opc/scripts/commands/session.mjs';
import { seedSession, createSessionRecord, F3_SESSION_ROUTES, SEED } from '../fixtures/f3-fake.mjs';

const pattern = () => ['ghp', 'Ab12'.repeat(10)].join('_');
const absent = (text, values) => { for (const value of values) assert.equal(text.includes(value), false, 'segredo deve ser mascarado'); };

test('C1: renderizadores mascaram títulos, tarefas, prévias e patches antes de truncar', () => {
  const token = pattern();
  const registered = 'registered-' + 'gate-value';
  registerSecret(registered);
  const text = `${token} ${registered}`;
  const session = { id: 'ses_gate', title: text, directory: text, agent: text, model: text };
  const outputs = [
    renderSessions([session], { statusMap: { ses_gate: { type: text } } }),
    renderSession(session, { messages: [{ info: { id: 'msg_gate', role: 'user' }, parts: [{ type: 'text', text }] }] }),
    renderSession({ id: 'ses_gate' }, { messages: [{ info: {}, parts: [{ type: 'text', text: `${'x '.repeat(47)}${token}` }] }] }),
    renderTodos([{ content: text, status: text, priority: text }]),
    renderTodos([{ content: `${'x '.repeat(77)}${token}` }]),
    renderSessionDiff([{ file: text, status: text, patch: `+${text}` }]),
    renderRevertPreview({ action: 'unrevert', sessionID: 'ses_gate', rawDiff: text, command: 'opc session unrevert ses_gate' }),
  ];
  for (const output of outputs) {
    absent(output, [token, registered]);
    assert.equal(output.includes('ghp_'), false, 'prévia não pode vazar prefixo de token truncado');
    assert.ok(output.includes('***'));
  }
});

test('M1: cabeçalho das tarefas em PT-BR', () => {
  assert.match(renderTodos([{ content: 'verificar' }], { sessionID: 'ses_gate' }), /^# Tarefas da sessão ses_gate/);
});

test('C2: redactTurnOutput mascara todos os campos do erro de provedor', () => {
  const token = pattern();
  const error = { name: token, message: token, data: { detail: [token] } };
  absent(JSON.stringify(redactTurnOutput({ error, errorMessage: token, errorType: token })), [token]);
});

async function workerFixture(t, dispatch) {
  const stateDir = trackTempDir(t, makeTempDir('opc-gate-worker-'));
  const { group, members } = await createGroup(stateDir, { kind: 'sub', title: 'OPC: teste' }, [{ title: 'membro' }]);
  const ctx = { stateDir, config: {}, json: () => {} };
  const api = { createSession: async () => ({ id: 'ses_parent' }), abort: async () => false };
  const request = { members: [{ agent: 'general', full: 'p/model' }], mechanism: 'child-session', rules: [], prompt: 'teste' };
  await runWorker(ctx, group, request, {
    openApi: async () => ({ api, close() {} }),
    createBridge: () => ({ dispose() {} }),
    dispatch: (args) => dispatch({ ...args, ctx, group, member: members[0] }),
  });
  return { ctx, group: readJob(stateDir, group.id), member: readJob(stateDir, members[0].id) };
}

test('C2: erro fake de provedor não persiste no membro/grupo nem em result/status JSON', async (t) => {
  const token = pattern();
  const registered = 'registered-' + 'provider-value';
  registerSecret(registered);
  const errorText = `${token} ${registered}`;
  const { ctx, group, member } = await workerFixture(t, async () => ({
    status: 'failed', error: { name: errorText, message: errorText, data: { message: errorText, nested: [errorText] } },
    errorType: errorText, errorMessage: errorText,
  }));
  assert.equal(member.status, 'failed');
  for (const job of [group, member]) {
    absent(readFileSync(join(ctx.stateDir, 'jobs', `${job.id}.json`), 'utf8'), [token, registered]);
    for (const command of [result, status]) {
      let output;
      await command({ ...ctx, json: (value) => { output = JSON.stringify(value); } }, [job.id, '--json']);
      absent(output, [token, registered]);
      assert.ok(output.includes('***'));
    }
  }
  // Also exercise top-level fields on a job update, independently of the coordinator.
  await updateJob(ctx.stateDir, member.id, { errorType: errorText, errorMessage: errorText });
  absent(readFileSync(join(ctx.stateDir, 'jobs', `${member.id}.json`), 'utf8'), [token, registered]);
});

test('I1: cancelamento recusado seguido de conclusão mantém membro completed', async (t) => {
  const { member, group } = await workerFixture(t, async ({ ctx, member, api, onSession }) => {
    await onSession('ses_member');
    const cancelled = await cancelJob(ctx, member.id, { api });
    assert.equal(cancelled.code, 'CANCEL_FAILED');
    return { status: 'completed', finalText: 'concluído', sessionID: 'ses_member' };
  });
  assert.equal(member.status, 'completed');
  assert.equal(member.cancelRequestedAt, null);
  assert.equal(group.status, 'completed');
});

test('I3: prévia de 250 mensagens localiza mensagem 10 fora da última página', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => ({ info: { id: `msg_${i + 1}`, role: 'user' } }));
  const reads = [];
  const api = {
    messages: async (_id, { limit }) => messages.slice(-limit),
    message: async (_id, id) => { reads.push(id); return messages.find((m) => m.info.id === id); },
    diff: async (_id, { messageID }) => [{ file: 'notes.txt', patch: `+${messageID}` }],
  };
  const preview = await collectAffectedDiff(api, 'ses_gate', 'msg_10');
  assert.deepEqual(reads, ['msg_10']);
  assert.ok(preview.some((d) => d.patch.includes('msg_10')));
  assert.equal(preview.previewTruncated, true);
});

test('LIVE-1: directory é string em sessões seed, criadas, filhas e forks', () => {
  const fake = { state: {}, emit() {} };
  seedSession(fake);
  createSessionRecord(fake);
  createSessionRecord(fake, { parentID: SEED.session }, '/workspace');
  F3_SESSION_ROUTES['POST /session/:id/fork'](fake, { params: { id: SEED.session } });
  for (const session of Object.values(fake.state.sessions)) assert.equal(typeof session.directory, 'string');
});
