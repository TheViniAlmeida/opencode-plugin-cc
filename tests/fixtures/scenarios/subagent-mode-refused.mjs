import { withF3, seedSession, createSessionRecord, bad, notFound, F3_AGENTS } from '../f3-fake.mjs';

// Simulates an OpenCode that refuses a subagent-mode agent as the agent of a session
// (spec §15 item 7): prompt_async with such an agent → 400. A `subtask` part works.
export default withF3({
  setup: seedSession,
  routes: {
    'POST /api/session/:id/prompt_async': (fake, { params, body = {} }) => {
      const session = fake.state.sessions[params.id];
      if (!session) return notFound(`session ${params.id} not found`);
      const mode = F3_AGENTS.find((a) => a.name === body.agent)?.mode;
      if (body.agent && mode === 'subagent') return bad(`Agent ${body.agent} is a subagent and cannot be used as the session agent`);
      // accepted prompts are recorded like the base route, so the assistant reply is parented to this turn's user message
      const messageID = body.messageID ?? `msg_refused_${Date.now()}`;
      fake.state.messages[params.id].push({ info: { id: messageID, sessionID: params.id, role: 'user', time: { created: Date.now() }, agent: body.agent ?? 'build', ...(body.model ? { model: body.model } : {}) }, parts: [] });
      session.lastUserMessageID = messageID;
      session.lastModel = body.model ?? null;
      fake.persist?.();
      const subtask = (body.parts ?? []).find((p) => p.type === 'subtask');
      if (subtask) {
        const child = createSessionRecord(fake, { parentID: params.id, title: `${subtask.description} (@${subtask.agent} subagent)`, agent: subtask.agent }, session.directory);
        fake.emitTurn(params.id, { text: `SUBTASK ${subtask.agent} ${subtask.model?.modelID ?? 'none'} via ${child.id}`, delayMs: 50 });
        return { status: 204 };
      }
      fake.emitTurn(params.id, { text: `DIRECT ${body.agent ?? 'default'}`, delayMs: 50 });
      return { status: 204 };
    },
  },
});
