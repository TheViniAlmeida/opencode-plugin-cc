// Emits caller-provided error text so integration tests can exercise runtime masking.
export default {
  onPrompt(fake, sessionID) {
    const value = process.env.FAKE_ERROR_TEXT ?? 'fixture-error';
    fake.emitTurn(sessionID, {
      text: '',
      // The type and message carry the caller-provided text into the job record and log, so the CLI must mask it at runtime.
      error: { type: `provider.error-${value}`, message: `provider failed: ${value}` },
      delayMs: 20,
    });
  },
};
