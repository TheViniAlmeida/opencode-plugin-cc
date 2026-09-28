// A subagent (child session) asks for a destructive bash command; the request must reach the job.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const child = fake.createChildSession(sessionID, { title: 'cleanup (@general subagent)', agent: 'general' });
    const outcome = await fake.askPermission(child.id, { permission: 'bash', patterns: ['rm -rf dist'], metadata: { command: 'rm -rf dist' }, always: ['rm *'] });
    if (outcome.aborted) return;
    await fake.emitTurn(sessionID, { text: `child ${child.id}: ${outcome.reply}`, tools: [{ tool: 'task', input: { description: 'cleanup', subagent_type: 'general' } }] });
  },
};
