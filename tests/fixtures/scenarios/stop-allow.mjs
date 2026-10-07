export default {
  onPrompt(fake, sessionID) {
    fake.emitTurn(sessionID, { text: 'ALLOW: o turno anterior não deixou nada que impeça o encerramento.' });
  },
};
