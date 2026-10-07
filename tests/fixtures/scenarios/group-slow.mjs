import { withF3, seedSession } from '../f3-fake.mjs';

function recordPrompt(fake, sessionID, body) {
  const session = fake.state.sessions[sessionID];
  fake.state.f3.prompts.push({ at: Date.now(), sessionID, agent: session.agent, model: session.model, text: body.text });
  fake.persist?.();
}
function answerAfterReply(fake, sessionID) {
  fake.persist?.();
  fake.emitTurn(sessionID, { text: 'AFTER REPLY', delayMs: 50 });
}
export default withF3({
  setup: seedSession,
  onPrompt(fake, sessionID, body) {
    recordPrompt(fake, sessionID, body);
    const delayMs = Number(process.env.FAKE_GROUP_DELAY_MS ?? 300);
    const session = fake.state.sessions[sessionID];
    const modelID = session.model.id;
    const failSuffix = process.env.FAKE_FAIL_MODEL;
    if (failSuffix && modelID.endsWith(failSuffix)) return fake.failExecution(sessionID, { type: 'provider.auth', message: 'Chave de API inválida.' });
    const ask = process.env.FAKE_GROUP_ASK;
    if (ask && modelID.endsWith('kimi-k3')) {
      fake.state.f3.askSession = sessionID;
      fake.setStatus(sessionID, { type: 'busy' });
      if (ask === 'question') {
        const form = { id: 'frm_f3_1', sessionID, title: 'Pergunta', metadata: { kind: 'question' }, fields: [{ key: 'q0', title: 'Opção', description: 'Escolha uma opção.', type: 'string', options: [{ value: 'A', label: 'A', description: 'Primeira' }, { value: 'B', label: 'B', description: 'Segunda' }], custom: false }] };
        fake.state.forms[form.id] = form;
        fake.emit({ type: 'form.created', data: { form } });
      } else {
        const request = { id: 'per_f3_1', sessionID, action: 'shell', resources: ['npm test'], save: [], source: { type: 'tool', messageID: 'msg_f3_1', id: 'call_f3_1' } };
        fake.state.permissions[request.id] = request;
        fake.emit({ type: 'permission.asked', data: request });
      }
      fake.persist?.();
      return;
    }
    return fake.emitTurn(sessionID, { text: `RESULT ${session.agent} ${modelID}`, delayMs });
  },
  routes: {
    'POST /api/session/:id/permission/:requestID/reply': (fake, { params, body = {} }) => {
      const request = fake.state.permissions[params.requestID];
      if (!request || request.sessionID !== params.id) return { status: 404, body: { _tag: 'NotFoundError', message: 'Permissão não encontrada' } };
      if (!['once', 'reject'].includes(body.decision)) return { status: 400, body: { _tag: 'InvalidRequestError', message: 'Decisão inválida' } };
      delete fake.state.permissions[params.requestID];
      fake.emit({ type: 'permission.replied', data: { sessionID: params.id, requestID: params.requestID, reply: body.decision } });
      answerAfterReply(fake, params.id);
      return { status: 204 };
    },
    'POST /api/session/:id/form/:formID/reply': (fake, { params, body = {} }) => {
      if (!fake.state.forms[params.formID]) return { status: 404, body: { _tag: 'NotFoundError', message: 'Formulário não encontrado' } };
      delete fake.state.forms[params.formID];
      fake.emit({ type: 'form.replied', data: { id: params.formID, sessionID: params.id, answer: body.answer ?? {} } });
      answerAfterReply(fake, params.id);
      return { status: 204 };
    },
    'DELETE /api/session/:id/form/:formID': (fake, { params }) => {
      if (!fake.state.forms[params.formID]) return { status: 404, body: { _tag: 'NotFoundError', message: 'Formulário não encontrado' } };
      delete fake.state.forms[params.formID];
      fake.emit({ type: 'form.cancelled', data: { id: params.formID, sessionID: params.id } });
      answerAfterReply(fake, params.id);
      return { status: 204 };
    },
  },
});
