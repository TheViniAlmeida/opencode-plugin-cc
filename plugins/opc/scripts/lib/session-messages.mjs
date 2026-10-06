// V2 lists flat messages in ascending order through the session API.
export async function readSessionMessages(api, sessionID, { limit = 200 } = {}) {
  return api.messages(sessionID, { limit });
}
