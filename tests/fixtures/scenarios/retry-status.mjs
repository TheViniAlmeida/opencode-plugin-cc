// OpenCode retries a 429 by itself (session.status retry) and then completes.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    fake.setStatus(sessionID, { type: 'retry', attempt: 1, message: 'APIError 429: rate limited', next: Date.now() + 500 });
    const retryWait = await fake.waitFor(sessionID, 500);
    if (retryWait.aborted || fake.isAborted(sessionID)) return;
    fake.setStatus(sessionID, { type: 'busy' });
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: 'recovered after retry' });
    if (fake.isAborted(sessionID)) return;
  },
};
