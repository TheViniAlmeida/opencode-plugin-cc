import { withF3, seedSession, ok } from '../f3-fake.mjs';

// Subagent groups: every prompt is answered after FAKE_GROUP_DELAY_MS with
// "RESULT <agent> <modelID>". FAKE_FAIL_MODEL=<suffix> makes that model fail fast.
// FAKE_GROUP_ASK=permission|question makes the kimi-k3 member ask before answering.
function recordPrompt(fake, sessionID, body) {
  fake.state.f3.prompts.push({ at: Date.now(), sessionID, agent: body.agent ?? null, model: body.model ?? null, parts: body.parts ?? [] });
  fake.persist?.();
}

function answerAfterReply(fake, sessionID) {
  delete fake.state.permissions?.per_f3_1;
  delete fake.state.questions?.que_f3_1;
  fake.persist?.();
  fake.emitTurn(sessionID, { text: 'AFTER REPLY', delayMs: 50 });
}

export default withF3({
  setup: seedSession,
  onPromptAsync(fake, sessionID, body) {
    recordPrompt(fake, sessionID, body);
    const delayMs = Number(process.env.FAKE_GROUP_DELAY_MS ?? 300);
    const modelID = body.model?.modelID ?? 'none';
    const failSuffix = process.env.FAKE_FAIL_MODEL;
    if (failSuffix && modelID.endsWith(failSuffix)) {
      return fake.emitTurn(sessionID, { error: { name: 'ProviderAuthError', data: { providerID: body.model.providerID, message: 'invalid api key' } }, delayMs: 50 });
    }
    const ask = process.env.FAKE_GROUP_ASK;
    if (ask && modelID.endsWith('kimi-k3')) {
      fake.state.f3.askSession = sessionID;
      if (ask === 'question') {
        const properties = { id: 'que_f3_1', sessionID, questions: [{ question: 'Qual opção?', header: 'Opção', options: [{ label: 'A', description: 'primeira' }, { label: 'B', description: 'segunda' }] }] };
        (fake.state.questions ??= {})[properties.id] = properties;
        fake.emit({ type: 'question.asked', properties });
      } else {
        const properties = { id: 'per_f3_1', sessionID, permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] };
        (fake.state.permissions ??= {})[properties.id] = properties;
        fake.emit({ type: 'permission.asked', properties });
      }
      fake.persist?.();
      return undefined;
    }
    const subtask = (body.parts ?? []).find((p) => p.type === 'subtask');
    const text = subtask ? `SUBTASK ${subtask.agent} ${subtask.model?.modelID ?? 'none'}` : `RESULT ${body.agent ?? 'default'} ${modelID}`;
    return fake.emitTurn(sessionID, { text, delayMs });
  },
  routes: {
    'POST /permission/:id/reply': (fake, { params, body = {} }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'permission.replied', properties: { sessionID, requestID: params.id, reply: body.reply } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
    'POST /question/:id/reply': (fake, { params, body = {} }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'question.replied', properties: { sessionID, requestID: params.id, answers: body.answers ?? [] } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
    'POST /question/:id/reject': (fake, { params }) => {
      const sessionID = fake.state.f3.askSession;
      fake.emit({ type: 'question.rejected', properties: { sessionID, requestID: params.id } });
      answerAfterReply(fake, sessionID);
      return ok(true);
    },
  },
});
