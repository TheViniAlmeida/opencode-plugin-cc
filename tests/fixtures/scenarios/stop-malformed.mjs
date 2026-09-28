export default {
  onPromptAsync(fake, sessionID) {
    fake.emitTurn(sessionID, { text: 'Revisei a alteração e ela parece estar quase toda correta.' });
  },
};
