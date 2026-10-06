// OpenCode schedules a provider retry and then completes.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    fake.event('session.retry.scheduled', { sessionID, assistantMessageID: 'msg_retry', attempt: 1, at: Date.now() + 500, error: { type: 'provider.transport', message: 'Limite de requisições.' } });
    const retryWait = await fake.waitFor(sessionID, 500);
    if (retryWait.aborted || fake.isAborted(sessionID)) return;
    fake.setStatus(sessionID, { type: 'busy' });
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: 'recovered after retry' });
    if (fake.isAborted(sessionID)) return;
  },
};
