export default {
  onPromptAsync(fake, sessionID) {
    fake.emitTurn(sessionID, {
      text: 'RAW_REVIEW_TEXT: a alteração parece arriscada, mas respondi em prosa.',
      error: { name: 'StructuredOutputError', data: { message: 'O modelo não produziu uma resposta estruturada.', retries: 2 } },
    });
  },
};
