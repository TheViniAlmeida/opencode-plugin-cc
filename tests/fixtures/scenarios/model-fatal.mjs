import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido termina o turno com ProviderAuthError fatal; os demais respondem normalmente.
export default {
  onPromptAsync(fake, sessionID, body) {
    if (isFailingModel(body)) {
      fake.emitTurn(sessionID, {
        text: '',
        error: { name: 'ProviderAuthError', data: { providerID: body.model.providerID, message: 'Chave de API inválida (falsa)' } },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(body));
  },
};
