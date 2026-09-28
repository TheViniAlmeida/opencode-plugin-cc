// OpenCode retries a 429 by itself (session.status retry) and then completes.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    fake.setStatus(sessionID, { type: 'retry', attempt: 1, message: 'APIError 429: rate limited', next: Date.now() + 500 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    fake.setStatus(sessionID, { type: 'busy' });
    await fake.emitTurn(sessionID, { text: 'recovered after retry' });
  },
};
