// Two pending requests in the same session; rejecting one rejects the sibling (OpenCode 1.18.32).
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const first = fake.askPermission(sessionID, { permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' }, always: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = fake.askPermission(sessionID, { permission: 'edit', patterns: ['src/app.js'], metadata: {}, always: [] });
    const outcomes = await Promise.all([first, second]);
    if (outcomes.some((o) => o.aborted)) return;
    await fake.emitTurn(sessionID, { text: `outcomes: ${outcomes.map((o) => o.reply).join(',')}` });
  },
};
