// V2 lists flat messages in ascending order through the session API. Without a limit the API follows every
// cursor page (at most 200 messages each); with one it stops after `limit` messages.
export async function readSessionMessages(api, sessionID, { limit } = {}) {
  return api.messages(sessionID, limit === undefined || limit === null ? {} : { limit });
}

// The turn starts at its user message, so the whole ascending list is read once.
export async function readTurnMessages(api, sessionID) {
  const messages = await readSessionMessages(api, sessionID);
  if (!Array.isArray(messages)) throw new Error('Resposta de mensagens inválida.');
  return messages;
}
