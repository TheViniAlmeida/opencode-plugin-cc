// V2 dispatches a subagent through the subagent tool and gives the child inherited policy/model.
import { withF3 } from '../f3-fake.mjs';

export default withF3({
  async onPrompt(fake, sessionID, body = {}) {
    const agent = body.agents?.[0] ?? 'explore';
    const child = fake.createChildSession(sessionID, { agent, title: 'OPC: subagente' });
    await fake.emitTurn(sessionID, {
      text: `SUBAGENT ${agent} via ${child.id}`,
      tools: [{ tool: 'subagent', input: { agent, description: 'Subagent task', prompt: body.text ?? '' }, output: `Session ${child.id}` }],
    });
  },
});
