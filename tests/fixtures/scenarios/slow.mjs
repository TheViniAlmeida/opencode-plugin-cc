// Long turn (~15 s) so tests can cancel, time out or run two jobs at once.
export default {
  async onPromptAsync(fake, sessionID) {
    await fake.emitTurn(sessionID, { text: 'slow turn finished', tools: [{ tool: 'read', input: { filePath: 'README.md' } }], delayMs: 3000 });
  },
};
