export default {
  onPromptAsync(fake, sessionID) {
    fake.emitTurn(sessionID, { text: '', error: { name: 'APIError', data: { message: '[402] Saldo insuficiente.', statusCode: 402 } } });
  },
};
