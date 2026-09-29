import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido conclui uma ferramenta edit em src/app.js e depois falha com APIError repetível.
export default {
  onPromptAsync(fake, sessionID, body) {
    if (isFailingModel(body)) {
      fake.emitTurn(sessionID, {
        text: '',
        tools: [{ tool: 'edit', input: { filePath: 'src/app.js', oldString: 'a', newString: 'b' }, output: 'Edição aplicada.' }],
        error: { name: 'APIError', data: { message: 'Serviço upstream sobrecarregado (503 falso)', statusCode: 503, isRetryable: true } },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(body));
  },
};
