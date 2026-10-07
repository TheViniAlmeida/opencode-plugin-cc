import { isFailingModel, successTurn } from './_model-select.mjs';

// O modelo escolhido conclui uma ferramenta edit em src/app.js e depois falha com APIError repetível.
export default {
  onPrompt(fake, sessionID, body) {
    if (isFailingModel(fake.state.sessions[sessionID])) {
      fake.emitTurn(sessionID, {
        text: '',
        tools: [{ tool: 'edit', input: { filePath: 'src/app.js', oldString: 'a', newString: 'b' }, output: 'Edição aplicada.' }],
        error: { type: 'provider.transport', message: 'Serviço upstream sobrecarregado (503 falso)' },
        delayMs: 20,
      });
      return;
    }
    fake.emitTurn(sessionID, successTurn(fake.state.sessions[sessionID]));
  },
};
