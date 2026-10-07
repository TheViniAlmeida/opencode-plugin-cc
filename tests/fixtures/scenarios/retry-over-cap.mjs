import { isFailingModel, successTurn } from './_model-select.mjs';

const TICK_MS = Number(process.env.FAKE_RETRY_TICK_MS ?? 40);
const MAX_TICKS = Number(process.env.FAKE_RETRY_MAX_TICKS ?? 50);

// O modelo escolhido emite retry.scheduled até o cliente interromper a sessão.
export default {
  onPrompt(fake, sessionID, body) {
    if (!isFailingModel(fake.state.sessions[sessionID])) {
      fake.emitTurn(sessionID, successTurn(fake.state.sessions[sessionID]));
      return;
    }
    fake.setStatus(sessionID, { type: 'busy' });
    let attempt = 0;
    const timer = setInterval(() => {
      // a rota de abort do fake já fecha o turno (erro MessageAbortedError + status idle)
      if (fake.state.aborts.includes(sessionID)) {
        clearInterval(timer);
        return;
      }
      if (attempt >= MAX_TICKS) {
        clearInterval(timer);
        fake.failExecution(sessionID, { type: 'provider.transport', message: 'Tentativas esgotadas.' });
        return;
      }
      attempt += 1;
      fake.event('session.retry.scheduled', { sessionID, assistantMessageID: 'msg_retry', attempt, at: Date.now() + 1000 * attempt, error: { type: 'provider.transport', message: 'Limite de requisições (falso)' } });
    }, TICK_MS);
  },
};
