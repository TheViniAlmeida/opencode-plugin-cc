// Domain operations over the OpenCode v1 API (spec §3). F1: read methods; F2a/F3 add writes.
import { UsageError } from './opc-error.mjs';

const GET = { retryOnServerDown: true };
const seg = (id) => encodeURIComponent(String(id));

export function createApi(client) {
  return {
    health: () => client.get('/global/health', GET),
    getConfig: () => client.get('/config', GET),
    providers: () => client.get('/provider', GET),
    agents: () => client.get('/agent', GET),
    commands: () => client.get('/command', GET),
    skills: () => client.get('/skill', GET),
    listSessions: () => client.get('/session', GET),
    getSession: (id) => client.get(`/session/${seg(id)}`, GET),
    sessionStatus: () => client.get('/session/status', GET),
    messages: (id, { limit } = {}) => client.get(`/session/${seg(id)}/message`, limit ? { ...GET, query: { limit } } : GET),
    children: (id) => client.get(`/session/${seg(id)}/children`, GET),
    diff: (id) => client.get(`/session/${seg(id)}/diff`, GET),
    todo: (id) => client.get(`/session/${seg(id)}/todo`, GET),
    listPermissions: () => client.get('/permission', GET),
    listQuestions: () => client.get('/question', GET),
    ...sessionWriteMethods(client),
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
