import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

export function memoryV2({ promptFailsOnce, createFailsOnce } = {}) {
  const handlers = new Map();
  const anyHandlers = new Set();
  let resolveCreated, resolvePrompt;
  let active = true;
  let createAttempt = 0;
  const messages = new Map();
  const sessions = new Map();
  const api = {
    calls: [], promptCalls: [], messageReadsBeforeEnd: 0,
    created: new Promise((resolve) => { resolveCreated = resolve; }),
    promptSettled: new Promise((resolve) => { resolvePrompt = resolve; }),
    async createSession(body) {
      createAttempt++;
      if (createFailsOnce && createAttempt === 1) throw createFailsOnce;
      this.createdBody = body; sessions.set('ses_mem1', body); resolveCreated('ses_mem1'); return { id: 'ses_mem1' };
    },
    async getSession(id) { const body = sessions.get(id) ?? this.createdBody; return { id, model: body.model, agent: body.agent, permissions: body.permissions }; },
    async setPermissions(id, rules) { this.calls.push(['setPermissions', id, rules]); },
    async setModel(id, model) { this.calls.push(['setModel', id, model]); },
    async setAgent(id, agent) { this.calls.push(['setAgent', id, agent]); },
    async prompt(id, body) {
      this.promptCalls.push(body);
      if (promptFailsOnce && this.promptCalls.length === 1) throw new RequestError(promptFailsOnce, 'timeout');
      resolvePrompt();
    },
    lastPromptId() { return this.promptCalls.at(-1)?.id; },
    messagesFor(id, list) { messages.set(id, list); },
    async finishAll(text) {
      await this.promptSettled;
      this.messagesFor('ses_mem1', [
        { id: this.lastPromptId(), type: 'user', text: this.promptCalls.at(-1).text },
        { id: 'msg_answer', type: 'assistant', content: [{ type: 'text', text }] },
        { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
      ]);
      emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_mem1' } });
    },
    async messages(id) { if (active) this.messageReadsBeforeEnd++; return messages.get(id) ?? []; },
    async sessionStatus() { return active ? { ses_mem1: { type: 'busy' } } : {}; },
    async children() { return []; },
    async listPermissions() { return []; },
    async listQuestions() { return []; },
    async interrupt() { return true; },
    async diff() { return []; },
  };
  const hub = {
    track(id, handler) { handlers.set(id, handler); return () => handlers.delete(id); },
    onReconnect() { return () => {}; },
    onAny(handler) { anyHandlers.add(handler); return () => anyHandlers.delete(handler); },
  };
  const emit = (event) => {
    for (const handler of anyHandlers) handler(event);
    if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) active = false;
    if (event.type === 'session.created' && event.data?.parentID && handlers.has(event.data.parentID)) {
      handlers.set(event.data.sessionID, handlers.get(event.data.parentID));
      const parent = sessions.get(event.data.parentID) ?? api.createdBody;
      sessions.set(event.data.sessionID, { model: parent.model, agent: parent.agent, permissions: structuredClone(parent.permissions) });
    }
    handlers.get(event.data?.sessionID)?.(event);
  };
  return { api, hub, emit };
}
