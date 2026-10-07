import { REVIEW_OK_STRUCTURED } from './review-ok.mjs';

// The review turn asks for bash, is refused by the read-only bridge, and still answers with the review JSON.
export default {
  async onPrompt(fake, sessionID) {
    fake.setStatus(sessionID, { type: 'busy' });
    const command = 'rm -rf build';
    const decision = await fake.askPermission(sessionID, { action: 'shell', resources: [command], save: ['rm *'] });
    if (fake.isAborted(sessionID)) return;
    const tools = decision === 'reject' ? [{ tool: 'shell', input: { command }, error: { type: 'permission.rejected', message: 'Permissão recusada.' } }] : [{ tool: 'shell', input: { command } }];
    await fake.emitTurn(sessionID, { text: JSON.stringify(REVIEW_OK_STRUCTURED), tools });
  },
};
