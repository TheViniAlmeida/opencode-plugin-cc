export default {
  onPrompt(fake, sessionID) {
    fake.emitTurn(sessionID, {
      text: 'RAW_REVIEW_TEXT: a alteração parece arriscada, mas respondi em prosa.',
      delayMs: 20,
    });
  },
};
