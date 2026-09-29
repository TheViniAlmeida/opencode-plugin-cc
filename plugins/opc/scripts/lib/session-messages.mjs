// OpenCode 1.18.32 cannot list sessions containing json_schema user messages.
// Keep the workaround scoped to a session/API connection; never swallow other 400s.
const sessions = new WeakMap();
function stateFor(api, sessionID) {
  let all = sessions.get(api);
  if (!all) { all = new Map(); sessions.set(api, all); }
  if (!all.has(sessionID)) all.set(sessionID, { perMessage: false, ids: new Set() });
  return all.get(sessionID);
}
export function rememberMessage(api, sessionID, id) {
  if (id) stateFor(api, sessionID).ids.add(id);
}
export function isPerMessageSession(api, sessionID) {
  return stateFor(api, sessionID).perMessage;
}
export function usePerMessageReads(api, sessionID) {
  stateFor(api, sessionID).perMessage = true;
}
export async function readSessionMessages(api, sessionID, { limit = 200, ids } = {}) {
  const state = stateFor(api, sessionID);
  if (!state.perMessage) {
    try {
      const messages = await api.messages(sessionID, { limit });
      for (const message of messages ?? []) rememberMessage(api, sessionID, message?.info?.id);
      return messages;
    } catch (err) {
      if (err?.code !== 'BAD_REQUEST' || !JSON.stringify(err.details?.body ?? '').includes('OutputFormatJsonSchema')) throw err;
      state.perMessage = true;
      if (state.ids.size === 0 && !ids) {
        const unavailable = [];
        unavailable.messagesUnavailable = true;
        return unavailable;
      }
    }
  }
  const messages = [];
  for (const id of ids ?? state.ids) {
    try {
      const message = await api.message(sessionID, id);
      if (message) messages.push(message);
    } catch (err) {
      if (err?.code !== 'NOT_FOUND') throw err;
    }
  }
  return messages;
}
