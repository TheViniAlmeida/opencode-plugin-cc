// OpenCode schedules a provider retry and then completes.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const at = Date.now() + 500;
    const error = { type: 'provider.transport', message: 'Limite de requisições.' };
    const assistantMessageID = 'msg_retry';
    const session = fake.state.sessions[sessionID];
    fake.state.messages[sessionID].push({ id: assistantMessageID, type: 'assistant', time: { created: Date.now() },
      agent: session.agent, model: session.model, content: [], cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      retry: { attempt: 1, at, error } });
    fake.persist?.();
    fake.event('session.retry.scheduled', { sessionID, assistantMessageID, attempt: 1, at, error });
    const retryWait = await fake.waitFor(sessionID, 500);
    if (retryWait.aborted || fake.isAborted(sessionID)) return;
    fake.setStatus(sessionID, { type: 'busy' });
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: 'recovered after retry' });
    if (fake.isAborted(sessionID)) return;
  },
};
