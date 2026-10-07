// Two independent pending permission requests in the same V2 session.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const first = fake.askPermission(sessionID, { action: 'shell', resources: ['rm -rf build'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fake.askPermission(sessionID, { action: 'edit', resources: ['src/app.js'] });
    const outcomes = await Promise.all([first, second]);
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: `Decisões: ${outcomes.join(',')}` });
  },
};
