import { REVIEW_OK_STRUCTURED } from './review-ok.mjs';

export default {
  onPrompt(fake, sessionID) {
    const delayMs = Number(process.env.FAKE_SLOW_MS ?? 30000);
    fake.emitTurn(sessionID, { text: `\`\`\`json\n${JSON.stringify(REVIEW_OK_STRUCTURED)}\n\`\`\``, delayMs });
  },
};
