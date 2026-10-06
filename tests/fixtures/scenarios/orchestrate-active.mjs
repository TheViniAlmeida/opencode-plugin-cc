// A live worker window long enough to exercise cancelGroup while its first attempt runs.
import normal from './decompose-ok.mjs';
import { classifyTurn } from '../orchestrate-turns.mjs';
export default {
  async onPrompt(fake, sessionID, body) {
    if (classifyTurn(body).role !== 'subtask') return normal.onPrompt(fake, sessionID, body);
    await fake.emitTurn(sessionID, { text: 'slow member finished', delayMs: 30000 });
  },
};
