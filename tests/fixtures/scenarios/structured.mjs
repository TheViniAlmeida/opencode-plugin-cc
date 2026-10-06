// V2 returns JSON as ordinary assistant text; the client validates it.
export default {
  async onPrompt(fake, sessionID) {
    await fake.emitTurn(sessionID, { text: JSON.stringify({ verdict: 'approve', count: 3 }) });
  },
};
