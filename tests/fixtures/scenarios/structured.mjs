// Structured output: OpenCode answers through the StructuredOutput tool and fills info.structured.
export default {
  async onPrompt(fake, sessionID) {
    const structured = { verdict: 'approve', count: 3 };
    await fake.emitTurn(sessionID, { text: '', structured, tools: [{ tool: 'StructuredOutput', input: structured, output: 'Structured output captured successfully.' }] });
  },
};
