// Structured output failure without other tools: raw text + StructuredOutputError (recoverable).
export default {
  async onPrompt(fake, sessionID) {
    await fake.emitTurn(sessionID, {
      text: 'raw text answer that is not valid JSON',
      error: { name: 'StructuredOutputError', data: { message: 'model output did not match the schema', retries: 1 } },
    });
  },
};
