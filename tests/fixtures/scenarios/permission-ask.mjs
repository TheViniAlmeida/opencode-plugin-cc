// The turn asks for bash (FAKE_PERMISSION_COMMAND, default "rm -rf build") and continues with the reply.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const command = process.env.FAKE_PERMISSION_COMMAND || 'rm -rf build';
    const outcome = await fake.askPermission(sessionID, { permission: 'bash', patterns: [command], metadata: { command }, always: [`${command.split(' ')[0]} *`] });
    if (outcome.aborted) return;
    if (outcome.reply === 'reject') {
      await fake.emitTurn(sessionID, { text: `rejected: ${outcome.message ?? ''}`.trim() });
      return;
    }
    await fake.emitTurn(sessionID, { text: `approved (${outcome.reply}) and ran: ${command}`, tools: [{ tool: 'bash', input: { command } }] });
  },
};
