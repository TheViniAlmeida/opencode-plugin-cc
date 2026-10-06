import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido termina o turno com erro APIError repetível (429); os demais respondem normalmente.
export default {
  onPrompt(fake, sessionID, body) {
    if (isFailingModel(fake.state.sessions[sessionID])) {
      fake.emitTurn(sessionID, {
        text: '',
        error: { type: 'provider.rate-limit', message: 'Limite de requisições excedido (429 falso)' },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(fake.state.sessions[sessionID]));
  },
};
