import { isFailingModel, successTurn } from './_model-select.mjs';

const TICK_MS = Number(process.env.FAKE_RETRY_TICK_MS ?? 40);
const MAX_TICKS = Number(process.env.FAKE_RETRY_MAX_TICKS ?? 50);

// O modelo escolhido entra em retry do OpenCode: session.status{type:'retry'} com attempt crescente e
// next (epoch ms) cada vez mais distante, até o cliente abortar a sessão (ou MAX_TICKS).
export default {
  onPromptAsync(fake, sessionID, body) {
    if (!isFailingModel(body)) {
      fake.emitTurn(sessionID, successTurn(body));
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
        fake.emitTurn(sessionID, { text: '', error: { name: 'MessageAbortedError', data: { message: 'A operação foi cancelada.' } } });
        return;
      }
      attempt += 1;
      fake.setStatus(sessionID, { type: 'retry', attempt, message: 'Limite de requisições (falso)', next: Date.now() + 1000 * attempt });
    }, TICK_MS);
  },
};
