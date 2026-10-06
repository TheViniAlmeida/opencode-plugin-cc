export default {
  onPrompt(fake, sessionID) {
    fake.emitTurn(sessionID, { text: '', error: { type: 'provider.payment-required', message: '[402] Saldo insuficiente.' } });
  },
};
