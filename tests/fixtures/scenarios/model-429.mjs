import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido termina o turno com erro APIError repetível (429); os demais respondem normalmente.
export default {
  onPromptAsync(fake, sessionID, body) {
    if (isFailingModel(body)) {
      fake.emitTurn(sessionID, {
        error: { name: 'APIError', data: { message: 'Limite de requisições excedido (429 falso)', statusCode: 429, isRetryable: true } },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(body));
  },
};
