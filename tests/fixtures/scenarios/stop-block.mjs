export default {
  onPrompt(fake, sessionID) {
    fake.emitTurn(sessionID, {
      text: 'BLOCK: divide() retorna a / 0 em math.js; corrija antes de encerrar.\n\nO turno anterior adicionou divide() e toda chamada retorna Infinity ou NaN.',
    });
  },
};
