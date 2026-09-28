// A final answer larger than 1 MB.
export default {
  async onPromptAsync(fake, sessionID) {
    const lines = Array.from({ length: 13000 }, (_, i) => `line ${i} ${'x'.repeat(90)}`);
    await fake.emitTurn(sessionID, { text: `${lines.join('\n')}\nEND-OF-LARGE-OUTPUT` });
  },
};
