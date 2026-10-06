// Emits caller-provided error text so integration tests can exercise runtime masking.
export default {
  onPrompt(fake, sessionID) {
    const value = process.env.FAKE_ERROR_TEXT ?? 'fixture-error';
    fake.emitTurn(sessionID, {
      text: '',
      error: { type: 'provider.transport', message: `Falha do provider: ${String(value).slice(0, 12)}…` },
      delayMs: 20,
    });
  },
};
