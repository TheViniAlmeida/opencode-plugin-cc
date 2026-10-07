// The turn fails before any assistant message.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.failExecution(sessionID, { type: 'provider.auth', message: 'Credenciais inválidas.' });
  },
};
