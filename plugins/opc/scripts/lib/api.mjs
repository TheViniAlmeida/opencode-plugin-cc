// Domain operations over the OpenCode v1 API (spec §3). F1: read methods; F2a/F3 add writes.
import { UsageError } from './opc-error.mjs';

const GET = { retryOnServerDown: true };
const apiSeg = (id) => encodeURIComponent(String(id));

export function createApi(client) {
  return {
    health: () => client.get('/global/health', GET),
    getConfig: () => client.get('/config', GET),
    providers: () => client.get('/provider', GET),
    agents: () => client.get('/agent', GET),
    commands: () => client.get('/command', GET),
    skills: () => client.get('/skill', GET),
    listSessions: () => client.get('/session', GET),
    getSession: (id) => client.get(`/session/${apiSeg(id)}`, GET),
    sessionStatus: () => client.get('/session/status', GET),
    message: (id, messageID) => client.get(`/session/${apiSeg(id)}/message/${apiSeg(messageID)}`, GET),
    messages: (id, { limit } = {}) => client.get(`/session/${apiSeg(id)}/message`, limit ? { ...GET, query: { limit } } : GET),
    children: (id) => client.get(`/session/${apiSeg(id)}/children`, GET),
    diff: (id) => client.get(`/session/${apiSeg(id)}/diff`, GET),
    todo: (id) => client.get(`/session/${apiSeg(id)}/todo`, GET),
    listPermissions: () => client.get('/permission', GET),
    listQuestions: () => client.get('/question', GET),
    ...sessionWriteMethods(client),
    ...f3Methods(client),
  };
}

// ---- F2a: write operations (spec §7, §8.2) ----

const segment = (value, name) => {
  if (typeof value !== 'string' || !value) {
    const shown = String(value ?? '').slice(0, 12);
    throw new UsageError('USAGE', `${name} é obrigatório${shown ? `: "${shown}…"` : ''}`);
  }
  return encodeURIComponent(value);
};

export function sessionWriteMethods(client) {
  return {
    createSession: (body) => client.post('/session', body),
    patchSession: (id, body) => client.patch(`/session/${segment(id, 'sessionID')}`, body),
    promptAsync: (id, body) => client.post(`/session/${segment(id, 'sessionID')}/prompt_async`, body),
    abort: (id) => client.post(`/session/${segment(id, 'sessionID')}/abort`, undefined),
    replyPermission: (requestID, { reply, message } = {}) => {
      if (reply !== 'once' && reply !== 'reject') {
        const shown = String(reply ?? '').slice(0, 12);
        throw new UsageError('INVALID_REPLY', `A resposta de permissão deve ser once ou reject; recebido "${shown}…"`);
      }
      return client.post(`/permission/${segment(requestID, 'requestID')}/reply`, message ? { reply, message } : { reply });
    },
    replyQuestion: (id, answers) => {
      if (!Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) {
        throw new UsageError('USAGE', 'As respostas da pergunta devem ser uma lista de listas de textos.');
      }
      return client.post(`/question/${segment(id, 'questionID')}/reply`, { answers });
    },
    rejectQuestion: (id) => client.post(`/question/${segment(id, 'questionID')}/reject`, undefined),
  };
}

// --- F3: session operations ----------------------------------------------------
const ID_BODY = /^[A-Za-z0-9_-]{1,160}$/;

export function assertId(prefix, value, label = prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !ID_BODY.test(value)) {
    const shown = String(value ?? '').slice(0, 12);
    throw new UsageError('INVALID_ID', `id inválido para ${label}: ${shown}${String(value ?? '').length > 12 ? '…' : ''} (esperado prefixo "${prefix}")`);
  }
  return value;
}

const seg = (prefix, id) => encodeURIComponent(assertId(prefix, id));

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null));
}

function f3Methods(client) {
  return {
    diff: (id, { messageID } = {}) =>
      client.get(`/session/${seg('ses', id)}/diff`, messageID ? { ...GET, query: { messageID: assertId('msg', messageID) } } : GET),
    fork: (id, { messageID } = {}) =>
      client.post(`/session/${seg('ses', id)}/fork`, messageID ? { messageID: assertId('msg', messageID) } : {}),
    revert: (id, { messageID, partID } = {}) => {
      if (!messageID) throw new UsageError('MISSING_MESSAGE_ID', 'revert exige messageID');
      const body = { messageID: assertId('msg', messageID) };
      if (partID) body.partID = assertId('prt', partID);
      return client.post(`/session/${seg('ses', id)}/revert`, body);
    },
    unrevert: (id) => client.post(`/session/${seg('ses', id)}/unrevert`, undefined),
    summarize: (id, { providerID, modelID, timeoutMs } = {}) => {
      if (!providerID || !modelID) throw new UsageError('MISSING_MODEL', 'summarize exige providerID e modelID');
      return client.post(`/session/${seg('ses', id)}/summarize`, { providerID, modelID }, timeoutMs ? { timeoutMs } : {});
    },
    runCommand: (id, { command, arguments: args = '', agent, model, variant, messageID, timeoutMs } = {}) => {
      if (!command) throw new UsageError('MISSING_COMMAND', 'runCommand exige o nome do command');
      if (model !== undefined && model !== null && typeof model !== 'string') {
        throw new UsageError('MODEL_NOT_STRING', 'runCommand: model deve ser a string "provider/model"');
      }
      if (typeof args !== 'string') throw new UsageError('ARGUMENTS_NOT_STRING', 'runCommand: arguments deve ser string');
      const body = { ...compact({ command, agent, model, variant, messageID }), arguments: args };
      const ordered = { command: body.command, arguments: body.arguments, ...body };
      return client.post(`/session/${seg('ses', id)}/command`, ordered, timeoutMs ? { timeoutMs } : {});
    },
    dispose: () => client.post('/instance/dispose', undefined),
  };
}
