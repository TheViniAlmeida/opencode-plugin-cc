// The turn fails through a session.error event (ProviderAuthError: fatal).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.event('session.error', { sessionID, error: { name: 'ProviderAuthError', data: { providerID: 'omniroute-personal', message: 'invalid credentials for provider' } } });
    fake.setStatus(sessionID, { type: 'idle' });
    fake.event('session.idle', { sessionID });
  },
};
