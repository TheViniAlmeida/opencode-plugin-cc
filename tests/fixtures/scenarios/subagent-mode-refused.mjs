// Reject a direct subagent session; the tool-created child inherits the carrier policy/model.
import { bad, withF3 } from '../f3-fake.mjs';

export default withF3({
  routes: {
    'POST /api/session': (_fake, { body }) => body?.agent === 'explore'
      ? bad('agent "explore" has subagent mode and cannot start a direct session') : undefined,
  },
  async onPrompt(fake, sessionID, body = {}) {
    const agent = body.agents?.[0] ?? 'explore';
    const child = fake.createChildSession(sessionID, { agent, title: 'OPC: subagente' });
    await fake.emitTurn(sessionID, {
      text: `SUBAGENT ${agent} via ${child.id}`,
      tools: [{ tool: 'subagent', input: { agent, description: 'Subagent task', prompt: body.text ?? '' }, output: `Session ${child.id}` }],
    });
  },
});
