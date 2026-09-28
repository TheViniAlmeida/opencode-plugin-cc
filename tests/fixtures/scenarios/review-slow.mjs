import { REVIEW_OK_STRUCTURED } from './review-ok.mjs';

export default {
  onPromptAsync(fake, sessionID, body) {
    const delayMs = Number(process.env.FAKE_SLOW_MS ?? 30000);
    if (body?.format?.type === 'json_schema') {
      fake.emitTurn(sessionID, { text: '', structured: REVIEW_OK_STRUCTURED, delayMs });
      return;
    }
    fake.emitTurn(sessionID, { text: 'ALLOW: o cenário lento foi concluído.', delayMs });
  },
};
