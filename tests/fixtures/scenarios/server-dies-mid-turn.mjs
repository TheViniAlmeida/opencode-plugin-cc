// The server process dies while the turn is busy (only usable through the fake binary).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    setTimeout(() => process.exit(1), 300);
  },
};
