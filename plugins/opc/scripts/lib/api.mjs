// Domain operations over the OpenCode v1 API (spec §3). F1: read methods; F2a/F3 add writes.
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
  };
}
