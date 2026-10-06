// V2 lists flat messages in ascending order through the session API.
export async function readSessionMessages(api, sessionID, { limit = 200 } = {}) {
  return api.messages(sessionID, { limit });
}

// The V2 list is ordered ascending and has no documented cursor. Increase the
// direct read until the current prompt is included or the list is exhausted.
export async function readTurnMessages(api, sessionID, messageID) {
  let limit = 200;
  for (;;) {
    const messages = await readSessionMessages(api, sessionID, { limit });
    if (!Array.isArray(messages)) throw new Error('Resposta de mensagens inválida.');
    if (messages.some((message) => message?.id === messageID) || messages.length < limit) return messages;
    if (limit >= 1_000_000) throw new Error('Limite de mensagens da sessão excedido.');
    limit *= 2;
  }
}
