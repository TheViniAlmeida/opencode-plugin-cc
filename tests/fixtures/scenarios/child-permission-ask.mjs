// A subagent (child session) asks for a destructive bash command; the request must reach the job.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const child = fake.createChildSession(sessionID, { title: 'cleanup (@general subagent)', agent: 'general' });
    const decision = await fake.askPermission(child.id, { action: 'shell', resources: ['rm -rf dist'], save: ['rm *'] });
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: `subagente: ${decision}`, tools: [{ tool: 'subagent', input: { description: 'cleanup', agent: 'general', prompt: 'Clean up dist.' } }] });
  },
};
