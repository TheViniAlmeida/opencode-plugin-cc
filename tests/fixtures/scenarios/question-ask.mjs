// Three questions (single choice, multiple choice, free text) in one question request.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const outcome = await fake.askQuestion(sessionID, [
      { key: 'q0', title: 'Banco de dados', description: 'Escolha o banco de dados.', type: 'string', options: [{ value: 'Postgres', label: 'Postgres', description: 'Relacional' }, { value: 'SQLite', label: 'SQLite', description: 'Embutido' }], custom: false },
      { key: 'q1', title: 'Recursos', description: 'Escolha os recursos.', type: 'multiselect', options: [{ value: 'A', label: 'A', description: 'Autenticação' }, { value: 'C', label: 'C', description: 'Cache' }], custom: false },
      { key: 'q2', title: 'Nome', description: 'Informe o nome.', type: 'string', options: [], custom: true },
    ]);
    if (fake.isAborted(sessionID)) return;
    await fake.emitTurn(sessionID, { text: outcome.cancelled ? 'Pergunta cancelada.' : 'Pergunta respondida.' });
  },
};
