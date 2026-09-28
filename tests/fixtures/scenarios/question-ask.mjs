// Three questions (single choice, multiple choice, free text) in one question request.
export default {
  async onPromptAsync(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const outcome = await fake.askQuestion(sessionID, [
      { question: 'Which database should the service use?', header: 'Database', options: [{ label: 'Postgres', description: 'Relational, server' }, { label: 'SQLite', description: 'Embedded' }], custom: false },
      { question: 'Which features are in scope?', header: 'Features', options: [{ label: 'A', description: 'Auth' }, { label: 'B', description: 'Billing' }, { label: 'C', description: 'Search' }], multiple: true, custom: false },
      { question: 'Name of the service?', header: 'Name', options: [{ label: 'default', description: 'Use the repository name' }], custom: true },
    ]);
    if (outcome.aborted) return;
    await fake.emitTurn(sessionID, { text: outcome.rejected ? 'question rejected' : `answers: ${JSON.stringify(outcome.answers)}` });
  },
};
