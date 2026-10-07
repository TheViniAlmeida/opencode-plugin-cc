export const REVIEW_OK_STRUCTURED = {
  verdict: 'needs-attention',
  summary: 'A alteração falha quando a entrada está vazia.',
  findings: [
    {
      severity: 'low',
      title: 'Nome de constante pouco claro',
      body: 'O nome da constante não informa o que ela armazena.',
      file: 'src/app.js',
      line_start: 2,
      line_end: 2,
      confidence: 0.3,
      recommendation: 'Renomeie a constante.',
    },
    {
      severity: 'critical',
      title: 'Falha com entrada vazia',
      body: 'values[0] é lido antes de verificar o tamanho da lista.',
      file: 'src/app.js',
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      recommendation: 'Retorne antes quando values estiver vazio.',
    },
  ],
  next_steps: ['Proteja o caminho de entrada vazia e adicione um teste.'],
};

export default {
  onPrompt(fake, sessionID) {
    fake.emitTurn(sessionID, { text: `\`\`\`json\n${JSON.stringify(REVIEW_OK_STRUCTURED)}\n\`\`\`` });
  },
};
