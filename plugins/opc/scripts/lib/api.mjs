// Domain operations over the OpenCode 2.0.22 API.
import { RequestError, UsageError } from './opc-error.mjs';
import { toAgent, toFormAnswer, toPermissionRequest, toQuestion, toSessionStatus } from './opencode-v2.mjs';

const GET = { retryOnServerDown: true };
const given = (value) => value !== undefined && value !== null;
const ID_BODY = /^[A-Za-z0-9_-]{1,160}$/;

export function assertId(prefix, value, label = prefix) {
  if (typeof value !== 'string' || !value.startsWith(`${prefix}_`) || value.length <= prefix.length + 1 || !ID_BODY.test(value)) {
    const shown = String(value ?? '').slice(0, 12);
    throw new UsageError('INVALID_ID', `id inválido para ${label}: ${shown ? `${shown}…` : '<valor>'} (esperado prefixo "${prefix}_")`);
  }
  return value;
}

const seg = (prefix, value) => encodeURIComponent(assertId(prefix, value));
const sessionPath = (id) => `/api/session/${seg('ses', id)}`;
// V2 refuses `limit` above 200 on message lists and pages them with an opaque cursor.
export const MAX_PAGE_LIMIT = 200;
export const MAX_PAGES = 1000;
const LIST_BODY = { ...GET, envelope: true };

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new UsageError('INVALID_LIMIT', `${label} deve ser um inteiro positivo.`);
  return value;
}

function pageLimit(value) {
  positiveInt(value, 'O limite da página');
  if (value > MAX_PAGE_LIMIT) throw new UsageError('INVALID_LIMIT', `O limite da página deve ser no máximo ${MAX_PAGE_LIMIT}.`);
  return value;
}

// Accepts the V2 `{ data, cursor }` envelope and clients that already unwrapped `data`.
export function toPage(body, label) {
  if (Array.isArray(body)) return { data: body, cursor: null };
  if (body && typeof body === 'object' && Array.isArray(body.data)) return { data: body.data, cursor: body.cursor ?? null };
  throw new RequestError('INVALID_RESPONSE', `${label}: resposta de lista inválida.`);
}

// Follows `cursor.next` until a short or empty page, a missing cursor or `limit` items. A repeated cursor or a
// page without new items means the server is not advancing: fail instead of looping.
export async function collectPages(readPage, { limit, pageSize, cursor: start, maxPages = MAX_PAGES } = {}) {
  const items = [];
  const seenIds = new Set();
  const seenCursors = new Set(given(start) ? [start] : []);
  let cursor = start;
  for (let page = 0; page < maxPages; page += 1) {
    const { data, cursor: pageCursor } = await readPage(cursor);
    let fresh = 0;
    for (const item of data) {
      const id = item?.id;
      if (given(id) && seenIds.has(id)) continue;
      if (given(id)) seenIds.add(id);
      items.push(item);
      fresh += 1;
    }
    if (given(limit) && items.length >= limit) return items.slice(0, limit);
    const next = pageCursor?.next;
    if (data.length === 0 || !next || (given(pageSize) && data.length < pageSize)) return items;
    if (fresh === 0 || seenCursors.has(next)) throw new RequestError('PAGINATION_LOOP', 'A paginação do OpenCode repetiu o cursor ou a página; leitura interrompida.');
    seenCursors.add(next);
    cursor = next;
  }
  throw new RequestError('PAGINATION_LIMIT', `A lista do OpenCode excedeu ${maxPages} páginas; leitura interrompida.`);
}

const validateAnswers = (answers) => {
  if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((value) => typeof value === 'string'))) {
    throw new UsageError('USAGE', 'As respostas da pergunta devem ser uma lista de listas de textos.');
  }
};

export function createApi(client) {
  // One V2 page; the cursor already carries the order, so `order` is only sent on the first page.
  const messagesPage = async (id, { limit = MAX_PAGE_LIMIT, cursor } = {}) => {
    const path = `${sessionPath(id)}/message`;
    const query = given(cursor) ? { limit: pageLimit(limit), cursor } : { order: 'asc', limit: pageLimit(limit) };
    return toPage(await client.get(path, { ...LIST_BODY, query }), 'GET /api/session/<id>/message');
  };
  // Every message in ascending order, or the first `limit` ones.
  const messages = async (id, { limit, cursor } = {}) => {
    const pageSize = Math.min(MAX_PAGE_LIMIT, given(limit) ? positiveInt(limit, 'O limite de mensagens') : MAX_PAGE_LIMIT);
    return collectPages((next) => messagesPage(id, { limit: pageSize, cursor: next }), { limit, pageSize, cursor });
  };
  // The newest `limit` messages (one explicit desc page), returned oldest first.
  const latestMessages = async (id, { limit } = {}) => {
    const { data } = toPage(await client.get(`${sessionPath(id)}/message`, { ...LIST_BODY, query: { order: 'desc', limit: pageLimit(limit) } }), 'GET /api/session/<id>/message');
    return [...data].reverse();
  };
  // The session list keeps the server's default page size unless a limit is given.
  // The first page carries the filter; cursor pages send only the cursor (and limit), as the message list requires.
  const sessionsPage = async ({ parentID, limit, cursor } = {}) => {
    const query = given(cursor)
      ? { ...(given(limit) ? { limit: pageLimit(limit) } : {}), cursor }
      : { ...(given(parentID) ? { parentID: assertId('ses', parentID) } : {}), ...(given(limit) ? { limit: pageLimit(limit) } : {}) };
    return toPage(await client.get('/api/session', { ...LIST_BODY, ...(Object.keys(query).length ? { query } : {}) }), 'GET /api/session');
  };
  // Every session (or the first `limit`). The parent filter is reapplied locally in case a cursor page ignores it.
  const listSessions = async ({ parentID, limit } = {}) => {
    const pageSize = given(limit) ? Math.min(MAX_PAGE_LIMIT, positiveInt(limit, 'O limite de sessões')) : undefined;
    const sessions = await collectPages((cursor) => sessionsPage({ parentID, limit: pageSize, cursor }), { limit, pageSize });
    return given(parentID) ? sessions.filter((session) => session?.parentID === parentID) : sessions;
  };
  return {
    info: () => client.get('/api/info', GET),
    getConfigSources: () => client.get('/api/config', GET),
    providers: () => client.get('/api/provider', GET),
    models: ({ timeoutMs } = {}) => client.get('/api/model', { ...GET, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    defaultModel: () => client.get('/api/model/default', GET),
    agents: async () => (await client.get('/api/agent', GET)).map(toAgent),
    commands: () => client.get('/api/command', GET),
    skills: () => client.get('/api/skill', GET),
    sessionsPage,
    listSessions,
    children: (id) => listSessions({ parentID: id }),
    getSession: (id) => client.get(sessionPath(id), GET),
    sessionStatus: async () => toSessionStatus(await client.get('/api/session/active', GET)),
    messagesPage,
    messages,
    latestMessages,
    message: (id, messageID) => client.get(`${sessionPath(id)}/message/${seg('msg', messageID)}`, GET),
    listPermissions: async (sessionID) => (await client.get(`${sessionPath(sessionID)}/permission`, GET)).map(toPermissionRequest),
    listQuestions: async (sessionID) => (await client.get(`${sessionPath(sessionID)}/form`, GET)).map(toQuestion).filter(Boolean),
    diff: (id) => client.get(`${sessionPath(id)}/diff`, GET),
    ...sessionWriteMethods(client),
  };
}

export function sessionWriteMethods(client) {
  return {
    createSession: async (body) => {
      if (!Array.isArray(body?.permissions) || body.permissions.length === 0 || !body.model?.providerID || !body.model?.id) {
        throw new UsageError('UNSAFE_SESSION', 'A sessão exige permissões explícitas e modelo com providerID e id.');
      }
      return client.post('/api/session', body);
    },
    setPermissions: (id, rules) => client.patch(sessionPath(id), { permissions: rules }),
    setModel: (id, model) => client.post(`${sessionPath(id)}/model`, { model }),
    setAgent: (id, agent) => client.post(`${sessionPath(id)}/agent`, { agent }),
    prompt: (id, { id: messageID, text, agents } = {}) => client.post(`${sessionPath(id)}/prompt`, { ...(given(messageID) ? { id: assertId('msg', messageID) } : {}), text, ...(given(agents) ? { agents } : {}) }),
    interrupt: async (id) => (await client.post(`${sessionPath(id)}/interrupt`, undefined)).interrupted,
    replyPermission: async (sessionID, requestID, { reply, message } = {}) => {
      if (reply !== 'once' && reply !== 'reject') {
        const shown = String(reply ?? '').slice(0, 12);
        throw new UsageError('INVALID_REPLY', `A resposta de permissão deve ser once ou reject; recebido "${shown ? `${shown}…` : '<valor>'}"`);
      }
      return client.post(`${sessionPath(sessionID)}/permission/${seg('per', requestID)}/reply`, { decision: reply, ...(message ? { message } : {}) });
    },
    replyQuestion: async (sessionID, question, answers) => {
      validateAnswers(answers);
      return client.post(`${sessionPath(sessionID)}/form/${seg('frm', question.id)}/reply`, toFormAnswer(question, answers));
    },
    rejectQuestion: (sessionID, formID) => client.delete(`${sessionPath(sessionID)}/form/${seg('frm', formID)}`),
    fork: (id, { before } = {}) => client.post(`${sessionPath(id)}/fork`, given(before) ? { before: assertId('msg', before) } : {}),
    revertStage: (id, { messageID } = {}) => {
      if (!given(messageID)) throw new UsageError('MISSING_MESSAGE_ID', 'A reversão exige messageID.');
      return client.post(`${sessionPath(id)}/revert/stage`, { messageID: assertId('msg', messageID) });
    },
    revertCommit: (id) => client.post(`${sessionPath(id)}/revert/commit`, undefined),
    revertClear: (id) => client.delete(`${sessionPath(id)}/revert`),
    // V2 requires an object body and answers with the queued compaction message.
    compact: (id, { timeoutMs } = {}) => client.post(`${sessionPath(id)}/compact`, {}, given(timeoutMs) ? { timeoutMs } : {}),
    runCommand: (id, { name, text } = {}) => {
      if (!name) throw new UsageError('MISSING_COMMAND', 'runCommand exige o nome do comando.');
      return client.post(`${sessionPath(id)}/command`, { name, text: text ?? '' });
    },
  };
}
