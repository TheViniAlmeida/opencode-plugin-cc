import { MAX_PAGE_LIMIT } from './api.mjs';

// V2 lists flat messages in ascending order through the session API. Without a limit the API follows every
// cursor page (at most 200 messages each); with one it stops after `limit` messages.
// With `latest` and a limit, the newest `limit` messages (capped at one page) come back oldest first.
export async function readSessionMessages(api, sessionID, { limit, latest = false } = {}) {
  if (latest && limit !== undefined && limit !== null) return api.latestMessages(sessionID, { limit: Math.min(limit, MAX_PAGE_LIMIT) });
  return api.messages(sessionID, limit === undefined || limit === null ? {} : { limit });
}

// The turn starts at its user message, so the whole ascending list is read once.
export async function readTurnMessages(api, sessionID) {
  const messages = await readSessionMessages(api, sessionID);
  if (!Array.isArray(messages)) throw new Error('Resposta de mensagens inválida.');
  return messages;
}
