// Emits caller-provided error text so integration tests can exercise runtime masking.
export default {
  onPromptAsync(fake, sessionID) {
    const value = process.env.FAKE_ERROR_TEXT ?? 'fixture-error';
    fake.emitTurn(sessionID, {
      text: '',
      error: { name: `APIError-${value}`, data: { message: `provider failed: ${value}`, statusCode: 429, isRetryable: true } },
      delayMs: 20,
    });
  },
};
