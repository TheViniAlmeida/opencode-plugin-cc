// V2 returns ordinary text; malformed JSON is rejected by the client.
export default {
  async onPrompt(fake, sessionID) {
    await fake.emitTurn(sessionID, { text: 'raw text answer that is not valid JSON' });
  },
};
