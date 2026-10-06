// The turn asks for bash (FAKE_PERMISSION_COMMAND, default "rm -rf build") and continues with the reply.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const command = process.env.FAKE_PERMISSION_COMMAND || 'rm -rf build';
    const decision = await fake.askPermission(sessionID, { action: 'shell', resources: [command], save: [`${command.split(' ')[0]} *`] });
    if (fake.isAborted(sessionID)) return;
    if (decision === 'reject') {
      await fake.emitTurn(sessionID, { text: 'Permissão recusada.', tools: [{ tool: 'shell', input: { command }, error: { type: 'permission.rejected', message: 'Permissão recusada.' } }] });
      return;
    }
    await fake.emitTurn(sessionID, { text: `Permissão concedida (${decision}).`, tools: [{ tool: 'shell', input: { command } }] });
  },
};
