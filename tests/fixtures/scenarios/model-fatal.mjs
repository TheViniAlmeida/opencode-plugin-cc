import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido termina o turno com ProviderAuthError fatal; os demais respondem normalmente.
export default {
  onPrompt(fake, sessionID, body) {
    if (isFailingModel(fake.state.sessions[sessionID])) {
      fake.emitTurn(sessionID, {
        text: '',
        error: { type: 'provider.auth', message: 'Chave de API inválida (falsa)' },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(fake.state.sessions[sessionID]));
  },
};
