// Domain operations over the OpenCode 2.0.22 API.
import { UsageError } from './opc-error.mjs';
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
const validateAnswers = (answers) => {
  if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((value) => typeof value === 'string'))) {
    throw new UsageError('USAGE', 'As respostas da pergunta devem ser uma lista de listas de textos.');
  }
};

export function createApi(client) {
  return {
    info: () => client.get('/api/info', GET),
    getConfigSources: () => client.get('/api/config', GET),
    providers: () => client.get('/api/provider', GET),
    models: ({ timeoutMs } = {}) => client.get('/api/model', { ...GET, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    defaultModel: () => client.get('/api/model/default', GET),
    agents: async () => (await client.get('/api/agent', GET)).map(toAgent),
    commands: () => client.get('/api/command', GET),
    skills: () => client.get('/api/skill', GET),
    listSessions: ({ parentID, limit } = {}) => client.get('/api/session', { ...GET, ...(given(parentID) || given(limit) ? { query: { ...(given(parentID) ? { parentID: assertId('ses', parentID) } : {}), ...(given(limit) ? { limit } : {}) } } : {}) }),
    children: (id) => client.get('/api/session', { ...GET, query: { parentID: assertId('ses', id) } }),
    getSession: (id) => client.get(sessionPath(id), GET),
    sessionStatus: async () => toSessionStatus(await client.get('/api/session/active', GET)),
    messages: (id, { limit = 200 } = {}) => client.get(`${sessionPath(id)}/message`, { ...GET, query: { order: 'asc', limit } }),
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
    compact: (id) => client.post(`${sessionPath(id)}/compact`, undefined),
    runCommand: (id, { name, text } = {}) => {
      if (!name) throw new UsageError('MISSING_COMMAND', 'runCommand exige o nome do comando.');
      return client.post(`${sessionPath(id)}/command`, { name, text: text ?? '' });
    },
  };
}
