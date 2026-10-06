// Additional V2 fake sessions, catalogs and deterministic seed data.
import { loadContractSample } from './contract-shapes.mjs';

export const F3_MODELS = Object.freeze({
  deepseek: 'omniroute-personal/opencode-go/deepseek-v4.1-flash',
  qwen: 'omniroute-personal/opencode-go/qwen3.8-max',
  kimi: 'omniroute-personal/opencode-go/kimi-k3',
  denied: 'omniroute-work/cx/gpt-5.5',
});
export const SEED = Object.freeze({
  session: 'ses_00000000000100000000000001', userSession: 'ses_00000000000200000000000002',
  m1: 'msg_00000000000100000000000001', m2: 'msg_00000000000200000000000002',
  m3: 'msg_00000000000300000000000003', m4: 'msg_00000000000400000000000004',
});
const model = (value) => { const [providerID, ...rest] = value.split('/'); return { providerID, id: rest.join('/') }; };
export const F3_PROVIDERS = [{ id: 'omniroute-personal', name: 'OmniRoute pessoal', activation: 'enabled' }, { id: 'omniroute-work', name: 'OmniRoute trabalho', activation: 'enabled' }];
export const F3_MODEL_CATALOG = Object.values(F3_MODELS).map((value) => {
  const selected = model(value);
  return { id: value, modelID: selected.id, providerID: selected.providerID, name: selected.id,
    capabilities: { toolcall: true, reasoning: false }, variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], status: 'active' };
});
const agent = (id, mode, extra = {}) => ({ id, name: id, mode, hidden: false, description: '', permissions: [], ...extra });
export const F3_AGENTS = [agent('build', 'primary'), agent('plan', 'primary'), agent('general', 'subagent'), agent('explore', 'subagent'), agent('work-secret', 'subagent'), agent('pinned-sub', 'subagent')];
export const F3_COMMANDS = [
  { id: 'echo', name: 'echo', description: 'Echo the arguments' },
  { id: 'sub-echo', name: 'sub-echo', description: 'Echo in a subtask' },
  { id: 'pinned-model', name: 'pinned-model', description: 'Pins a denied model' },
  { id: 'pinned-agent', name: 'pinned-agent', description: 'Pins a denied agent' },
];
export const F3_OPENCODE_CONFIG = [{ type: 'document', path: '<workspace>/opencode.json', info: {} }];
export const F3_TEST_CONFIG = { defaultProvider: 'omniroute-personal', defaultModel: F3_MODELS.deepseek,
  aliases: { fast: F3_MODELS.deepseek, strong: F3_MODELS.qwen, k3: F3_MODELS.kimi },
  policy: { providers: { allow: [], deny: ['omniroute-work'] }, models: { allow: [], deny: [] }, agents: { allow: [], deny: ['work-*'] }, tools: { deny: [] }, sensitivePaths: ['*.env', '*.env.*'], destructiveBash: [], approver: 'user', permissionTimeoutSec: 600 },
  jobs: { maxActive: 8, maxParallel: 4 } };
export const ok = (data) => ({ status: 200, body: { data } });
export const bad = (message) => ({ status: 400, body: { _tag: 'InvalidRequestError', message } });
export const notFound = () => ({ status: 404, body: { _tag: 'NotFoundError', message: 'Recurso não encontrado' } });
const persist = (fake) => fake.persist?.();
const nextId = (fake, prefix) => { fake.state.f3.seq += 1; const seq = fake.state.f3.seq; return `${prefix}_${seq.toString(16).padStart(12, '0')}${String(seq).padStart(14, '0')}`; };
const TOKENS = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
function initF3State(fake) { fake.state.sessions ??= {}; fake.state.messages ??= {}; fake.state.f3 ??= { seq: 0, diffs: {}, messageDiffs: {}, prompts: [] }; }
export function userMessage(_sessionID, id, text, created = Date.now()) { return { id, type: 'user', time: { created }, text }; }
export function assistantMessage(_sessionID, id, _parentID, text, { providerID = 'omniroute-personal', modelID = 'opencode-go/deepseek-v4.1-flash', agent: agentName = 'build', error, created = Date.now() } = {}) {
  return { id, type: 'assistant', time: { created, completed: created }, agent: agentName, model: { providerID, id: modelID },
    content: text ? [{ type: 'text', text }] : [], finish: 'stop', cost: 0, tokens: TOKENS, ...(error ? { error } : {}) };
}
export function createSessionRecord(fake, body = {}, directory = null) {
  initF3State(fake);
  const session = fake.createSession({ ...body, model: body.model ?? model(F3_MODELS.deepseek), permissions: body.permissions ?? [{ action: '*', resource: '*', effect: 'deny' }] }, directory ?? '<workspace>');
  return session;
}
export function seedSession(fake) {
  initF3State(fake);
  const t0 = Date.now() - 60000;
  const base = loadContractSample('session.json').data;
  const make = (id, title, updated) => ({ ...structuredClone(base), id, title, time: { created: t0, updated }, location: { directory: process.cwd() } });
  fake.state.sessions[SEED.session] = make(SEED.session, 'OPC: task: seeded session', t0 + 4000);
  fake.state.sessions[SEED.userSession] = make(SEED.userSession, 'User session from the TUI', t0 + 1000);
  const injected = process.env.FAKE_SESSION_CONTENT ?? '';
  if (injected) fake.state.sessions[SEED.session].title = `OPC: task: ${injected}`;
  fake.state.messages[SEED.session] = [userMessage(SEED.session, SEED.m1, injected || 'first question', t0 + 1000),
    assistantMessage(SEED.session, SEED.m2, SEED.m1, 'first answer', { created: t0 + 2000 }),
    userMessage(SEED.session, SEED.m3, 'second question', t0 + 3000),
    assistantMessage(SEED.session, SEED.m4, SEED.m3, 'second answer', { created: t0 + 4000 }),
    { id: 'msg_00000000000500000000000005', type: 'idle', time: { created: t0 + 4001 }, outcome: 'succeeded' }];
  fake.state.messages[SEED.userSession] = [];
  const alpha = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n original\n+ALPHA\n' };
  const beta = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,2 +1,3 @@\n original\n ALPHA\n+BETA\n' };
  const extra = { file: 'extra.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+new file\n' };
  fake.state.f3.diffs[SEED.session] = [{ file: 'notes.txt', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1,3 @@\n original\n+ALPHA\n+BETA\n' }];
  fake.state.f3.messageDiffs[SEED.session] = { [SEED.m1]: [alpha], [SEED.m3]: [beta, extra] };
  persist(fake);
}
const hugeDiff = () => ({ file: 'huge.txt', status: 'added', additions: 250000, deletions: 0, patch: '+x\n'.repeat(250000) });
export const F3_DATA = { 'provider.json': F3_PROVIDERS, 'model.json': F3_MODEL_CATALOG, 'agent.json': F3_AGENTS, 'command.json': F3_COMMANDS, 'config.json': F3_OPENCODE_CONFIG };
export const F3_SESSION_ROUTES = {
  'GET /api/session/:id/diff': (fake, { params, query = {} }) => {
    const seeded = query.messageID ? fake.state.f3.messageDiffs[params.id]?.[query.messageID] : undefined;
    const base = query.messageID ? (seeded ?? []) : (process.env.FAKE_EMPTY_SESSION_DIFF === '1' ? [] : fake.state.f3.diffs[params.id] ?? []);
    return ok(process.env.FAKE_HUGE_DIFF === '1' && !query.messageID ? [...base, hugeDiff()] : base);
  },
  'POST /api/session/:id/fork': (fake, { params, body = {} }) => {
    const src = fake.state.sessions[params.id];
    if (!src) return notFound();
    const msgs = fake.state.messages[params.id] ?? [];
    const index = body.before ? msgs.findIndex((m) => m.id === body.before) : msgs.length;
    if (index < 0) return bad('Mensagem não encontrada');
    const forked = createSessionRecord(fake, { title: `${src.title} (fork #1)`, permissions: src.permissions, model: src.model }, src.location.directory);
    forked.fork = { sessionID: src.id, boundary: body.before ?? null };
    fake.state.messages[forked.id] = structuredClone(msgs.slice(0, index));
    persist(fake);
    return ok(forked);
  },
  'POST /api/session/:id/revert/stage': (fake, { params, body = {} }) => {
    const session = fake.state.sessions[params.id];
    if (!session) return notFound();
    if (!body.messageID || !fake.state.messages[params.id]?.some((m) => m.id === body.messageID)) return bad('Mensagem não encontrada');
    const msgs = fake.state.messages[params.id];
    const index = msgs.findIndex((m) => m.id === body.messageID);
    const positions = new Map(msgs.map((m, i) => [m.id, i]));
    const diff = Object.entries(fake.state.f3.messageDiffs[params.id] ?? {}).filter(([key]) => positions.get(key) >= index).flatMap(([, diffs]) => diffs.map((d) => d.patch)).join('\n');
    session.revert = { messageID: body.messageID, snapshot: 'snap_fake', diff };
    persist(fake);
    return ok(session);
  },
  'POST /api/session/:id/revert/commit': (fake, { params }) => {
    const session = fake.state.sessions[params.id];
    if (!session || !session.revert) return notFound();
    session.revert.committed = true;
    persist(fake);
    return ok(session);
  },
  'DELETE /api/session/:id/revert': (fake, { params }) => {
    const session = fake.state.sessions[params.id];
    if (!session) return notFound();
    delete session.revert;
    persist(fake);
    return ok(session);
  },
  'POST /api/session/:id/compact': (fake, { params, body = {} }) => {
    if (!fake.state.sessions[params.id]) return notFound();
    const selected = fake.state.sessions[params.id].model;
    fake.state.messages[params.id].push(assistantMessage(params.id, nextId(fake, 'msg'), null, 'Resumo da conversa.', { providerID: selected.providerID, modelID: selected.id, agent: 'compaction' }));
    persist(fake);
    return { status: 204 };
  },
  'POST /api/session/:id/command': (fake, { params, body = {} }) => {
    if (typeof body.name !== 'string' || typeof body.text !== 'string') return bad('Comando e argumentos obrigatórios');
    if (!F3_COMMANDS.some((c) => c.name === body.name)) return bad('Comando não encontrado');
    if (!fake.state.sessions[params.id]) return notFound();
    fake.state.messages[params.id].push(userMessage(params.id, nextId(fake, 'msg'), `/${body.name} ${body.text}`));
    fake.setStatus(params.id, { type: 'busy' });
    persist(fake);
    setTimeout(() => {
      const error = process.env.FAKE_COMMAND_ERROR === '1' ? { type: 'ProviderAuthError', message: 'Falha de autenticação do provider.' } : undefined;
      fake.emitTurn(params.id, { text: `COMANDO ${body.name} ARGUMENTOS[${body.text}]`, error }).catch(() => {});
    }, Number(process.env.FAKE_COMMAND_DELAY_MS ?? 0));
    return { status: 204 };
  },
};
export function withF3(scenario = {}) {
  const routes = Object.fromEntries(Object.entries(scenario.routes ?? {}).map(([key, value]) => [key.replace(/^(GET|POST|PATCH|DELETE) \/(?!api\/)/, '$1 /api/'), value]));
  return { ...scenario, data: { ...F3_DATA, ...(scenario.data ?? {}) },
    setup(fake) { initF3State(fake); scenario.setup?.(fake); persist(fake); },
    routes: { ...F3_SESSION_ROUTES, ...routes } };
}
