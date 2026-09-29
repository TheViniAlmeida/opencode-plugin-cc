// F3 extensions for the fake OpenCode server: session operations, catalogs and seed data.
// Used only through F3 scenarios (withF3), so F0–F2b scenarios keep their behavior.

export const F3_MODELS = Object.freeze({
  deepseek: 'omniroute-personal/opencode-go/deepseek-v4.1-flash',
  qwen: 'omniroute-personal/opencode-go/qwen3.8-max',
  kimi: 'omniroute-personal/opencode-go/kimi-k3',
  denied: 'omniroute-work/cx/gpt-5.5',
});

export const SEED = Object.freeze({ session: 'ses_seed', userSession: 'ses_user', m1: 'msg_seed_001', m2: 'msg_seed_002', m3: 'msg_seed_003', m4: 'msg_seed_004' });

function fakeModel(providerID, id) {
  return { id, providerID, name: id, family: id.split('/').pop(), api: { id, url: 'http://127.0.0.1/fake', npm: '@ai-sdk/openai-compatible' }, capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 128000, output: 8192 }, status: 'active', options: {}, headers: {}, release_date: '2026-01-01', variants: {} };
}
function fakeProvider(id, modelIDs) { return { id, name: id, source: 'config', env: [], options: {}, models: Object.fromEntries(modelIDs.map((m) => [m, fakeModel(id, m)])) }; }
export const F3_PROVIDERS = { all: [fakeProvider('omniroute-personal', ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3']), fakeProvider('omniroute-work', ['cx/gpt-5.5'])], default: { 'omniroute-personal': 'opencode-go/deepseek-v4.1-flash', 'omniroute-work': 'cx/gpt-5.5' }, connected: ['omniroute-personal', 'omniroute-work'] };
const agent = (name, mode, extra = {}) => ({ name, mode, native: false, permission: [], options: {}, ...extra });
export const F3_AGENTS = [agent('build', 'primary', { native: true }), agent('plan', 'primary', { native: true }), agent('general', 'subagent', { native: true }), agent('explore', 'subagent', { native: true }), agent('work-secret', 'subagent'), agent('pinned-sub', 'subagent', { model: { providerID: 'omniroute-work', modelID: 'cx/gpt-5.5' } })];
export const F3_COMMANDS = [
  { name: 'echo', description: 'Echo the arguments', template: 'Reply with: $ARGUMENTS', hints: ['$ARGUMENTS'], source: 'command' },
  { name: 'sub-echo', description: 'Echo in a subtask', template: 'Reply with: $ARGUMENTS', hints: ['$ARGUMENTS'], source: 'command', subtask: true, agent: 'general' },
  { name: 'pinned-model', description: 'Pins a denied model', template: 'x', hints: [], source: 'command', model: F3_MODELS.denied },
  { name: 'pinned-agent', description: 'Pins a denied agent', template: 'x', hints: [], source: 'command', agent: 'work-secret' },
];
export const F3_OPENCODE_CONFIG = { model: F3_MODELS.deepseek, share: 'manual' };
export const F3_TEST_CONFIG = { defaultProvider: 'omniroute-personal', defaultModel: F3_MODELS.deepseek, aliases: { fast: F3_MODELS.deepseek, strong: F3_MODELS.qwen, k3: F3_MODELS.kimi }, policy: { providers: { allow: [], deny: ['omniroute-work'] }, models: { allow: [], deny: [] }, agents: { allow: [], deny: ['work-*'] }, tools: { deny: [] }, sensitivePaths: ['*.env', '*.env.*'], destructiveBash: [], approver: 'user', permissionTimeoutSec: 600 }, jobs: { maxActive: 8, maxParallel: 4 } };

export const ok = (body) => ({ status: 200, body });
export const bad = (message) => ({ status: 400, body: { name: 'BadRequest', data: { message } } });
export const notFound = (message) => ({ status: 404, body: { name: 'NotFoundError', data: { message } } });
const persist = (fake) => fake.persist?.();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function initF3State(fake) { fake.state.sessions ??= {}; fake.state.messages ??= {}; fake.state.f3 ??= { seq: 0, diffs: {}, messageDiffs: {}, todos: {}, disposed: 0, prompts: [] }; }
function nextId(fake, prefix) { fake.state.f3.seq += 1; return `${prefix}_f3${String(fake.state.f3.seq).padStart(6, '0')}`; }
export function userMessage(sessionID, id, text, created = Date.now()) {
  return { info: { id, sessionID, role: 'user', time: { created }, agent: 'build', model: { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash' } }, parts: [{ id: `prt_${id.slice(4)}`, sessionID, messageID: id, type: 'text', text }] };
}
export function assistantMessage(sessionID, id, parentID, text, { providerID = 'omniroute-personal', modelID = 'opencode-go/deepseek-v4.1-flash', agent: agentName = 'build', summary = false, error = undefined, created = Date.now() } = {}) {
  return { info: { id, sessionID, role: 'assistant', time: { created, completed: created }, parentID, modelID, providerID, mode: agentName, agent: agentName, path: { cwd: '/fake', root: '/fake' }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop', ...(summary ? { summary: true } : {}), ...(error ? { error } : {}) }, parts: text ? [{ id: `prt_${id.slice(4)}`, sessionID, messageID: id, type: 'text', text }] : [] };
}
export function createSessionRecord(fake, body = {}, directory = null) {
  initF3State(fake); const id = nextId(fake, 'ses'); const now = Date.now();
  const session = { id, slug: id.slice(4), projectID: 'prj_fake', directory: directory ?? '/fake', title: body.title ?? `New session ${id}`, version: '1.18.32', time: { created: now, updated: now }, ...(body.parentID ? { parentID: body.parentID } : {}), ...(body.agent ? { agent: body.agent } : {}), ...(body.model ? { model: body.model } : {}), ...(body.permission ? { permission: body.permission } : {}), ...(body.metadata ? { metadata: body.metadata } : {}) };
  fake.state.sessions[id] = session; fake.state.messages[id] ??= []; fake.emit({ type: 'session.created', properties: { sessionID: id, info: session } }); persist(fake); return session;
}
export function seedSession(fake) {
  initF3State(fake); const t0 = Date.now() - 60000; const s = SEED.session;
  fake.state.sessions[s] = { id: s, slug: 'seed', projectID: 'prj_fake', directory: process.cwd(), title: 'OPC: task: seeded session', version: '1.18.32', time: { created: t0, updated: t0 + 4000 } };
  fake.state.sessions[SEED.userSession] = { id: SEED.userSession, slug: 'user', projectID: 'prj_fake', directory: process.cwd(), title: 'User session from the TUI', version: '1.18.32', time: { created: t0, updated: t0 + 1000 } };
  const injected = process.env.FAKE_SESSION_CONTENT ?? '';
  if (injected) fake.state.sessions[s].title = `OPC: task: ${injected}`;
  fake.state.messages[s] = [userMessage(s, SEED.m1, injected || 'first question', t0 + 1000), assistantMessage(s, SEED.m2, SEED.m1, 'first answer', { created: t0 + 2000 }), userMessage(s, SEED.m3, 'second question', t0 + 3000), assistantMessage(s, SEED.m4, SEED.m3, 'second answer', { created: t0 + 4000 })]; fake.state.messages[SEED.userSession] = [];
  const alpha = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n original\n+ALPHA\n' };
  const beta = { file: 'notes.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,2 +1,3 @@\n original\n ALPHA\n+BETA\n' };
  const extra = { file: 'extra.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+new file\n' };
  if (injected) alpha.patch += `+${injected}\n`;
  fake.state.f3.diffs[s] = [{ file: 'notes.txt', status: 'modified', additions: 2, deletions: 0, patch: `@@ -1 +1,3 @@\n original\n+ALPHA\n+BETA\n${injected ? `+${injected}\n` : ''}` }]; fake.state.f3.messageDiffs[s] = { [SEED.m1]: [alpha], [SEED.m3]: [beta, extra] };
  fake.state.f3.todos[s] = [{ content: injected || 'check alpha', status: 'completed', priority: 'high' }, { content: 'check beta', status: 'pending', priority: 'low' }]; persist(fake);
}
function hugeDiff() { return { file: 'huge.txt', status: 'added', additions: 250000, deletions: 0, patch: '+x\n'.repeat(250000) }; }
export const F3_DATA = { 'provider.json': F3_PROVIDERS, 'agent.json': F3_AGENTS, 'command.json': F3_COMMANDS, 'config.json': F3_OPENCODE_CONFIG };
export const F3_SESSION_ROUTES = {
  'POST /session': (fake, { body = {}, query = {} }) => ok(createSessionRecord(fake, body, query.directory ?? null)),
  'GET /session': (fake) => ok(Object.values(fake.state.sessions).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))),
  'GET /session/:id': (fake, { params }) => fake.state.sessions[params.id] ? ok(fake.state.sessions[params.id]) : notFound(`session ${params.id} not found`),
  'GET /session/:id/children': (fake, { params }) => ok(Object.values(fake.state.sessions).filter((s) => s.parentID === params.id)),
  'GET /session/:id/diff': (fake, { params, query = {} }) => { const seeded = query.messageID ? fake.state.f3.messageDiffs[params.id]?.[query.messageID] : undefined; const base = query.messageID ? (seeded ?? (process.env.FAKE_TARGET_DIFF === '1' ? [{ file: 'target.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n base\n+TARGET\n' }] : [])) : (fake.state.f3.diffs[params.id] ?? []); return ok(process.env.FAKE_HUGE_DIFF === '1' && !query.messageID ? [...base, hugeDiff()] : base); },
  'GET /session/:id/todo': (fake, { params }) => ok(fake.state.f3.todos[params.id] ?? []),
  'POST /session/:id/fork': (fake, { params, body = {} }) => { const src = fake.state.sessions[params.id]; if (!src) return notFound(`session ${params.id} not found`); const msgs = fake.state.messages[params.id] ?? []; const targetIndex = body.messageID ? msgs.findIndex((m) => m.info.id === body.messageID) : -1; if (body.messageID && targetIndex < 0) return bad(`message ${body.messageID} not found`); const kept = body.messageID ? msgs.slice(0, targetIndex) : msgs; const forked = createSessionRecord(fake, { title: `${src.title} (fork #1)` }, src.directory); fake.state.messages[forked.id] = kept.map((m) => ({ info: { ...m.info, sessionID: forked.id }, parts: m.parts.map((p) => ({ ...p, sessionID: forked.id })) })); persist(fake); return ok(forked); },
  'POST /session/:id/revert': (fake, { params, body = {} }) => { const session = fake.state.sessions[params.id]; if (!session) return notFound(`session ${params.id} not found`); if (!body.messageID) return bad('messageID is required'); const msgs = fake.state.messages[params.id] ?? []; if (!msgs.some((m) => m.info.id === body.messageID)) return bad(`message ${body.messageID} not found`); const perMessage = fake.state.f3.messageDiffs[params.id] ?? {}; const position = new Map(msgs.map((m, i) => [m.info.id, i])); const from = position.get(body.messageID); const diff = Object.entries(perMessage).filter(([id]) => (position.get(id) ?? -1) >= from).flatMap(([, diffs]) => diffs.map((d) => d.patch)).join('\n'); session.revert = { messageID: body.messageID, ...(body.partID ? { partID: body.partID } : {}), snapshot: 'snap_fake', diff }; session.time.updated = Date.now(); fake.emit({ type: 'session.updated', properties: { sessionID: params.id, info: session } }); persist(fake); return ok(session); },
  'POST /session/:id/unrevert': (fake, { params }) => { const session = fake.state.sessions[params.id]; if (!session) return notFound(`session ${params.id} not found`); delete session.revert; session.time.updated = Date.now(); fake.emit({ type: 'session.updated', properties: { sessionID: params.id, info: session } }); persist(fake); return ok(session); },
  'POST /session/:id/summarize': (fake, { params, body = {} }) => { if (!fake.state.sessions[params.id]) return notFound(`session ${params.id} not found`); if (!body.providerID || !body.modelID) return bad('providerID and modelID are required'); const msgs = fake.state.messages[params.id] ??= []; const parent = [...msgs].reverse().find((m) => m.info.role === 'user')?.info.id ?? 'msg_none'; msgs.push(assistantMessage(params.id, nextId(fake, 'msg'), parent, 'Summary of the conversation.', { providerID: body.providerID, modelID: body.modelID, agent: 'compaction', summary: true })); persist(fake); return ok(true); },
  'POST /session/:id/command': async (fake, { params, body = {} }) => { if (typeof body.command !== 'string' || typeof body.arguments !== 'string') return bad('command and arguments are required'); const cmd = F3_COMMANDS.find((c) => c.name === body.command); if (!cmd) return bad(`command ${body.command} not found`); if (!fake.state.sessions[params.id]) return notFound(`session ${params.id} not found`); const delay = Number(process.env.FAKE_COMMAND_DELAY_MS ?? 0); if (delay > 0) await sleep(delay); const [providerID, ...rest] = String(body.model ?? F3_MODELS.deepseek).split('/'); const userID = nextId(fake, 'msg'); const msgs = fake.state.messages[params.id] ??= []; msgs.push(userMessage(params.id, userID, `/${body.command} ${body.arguments}`.trim())); const error = process.env.FAKE_COMMAND_ERROR === '1' ? { name: 'ProviderAuthError', data: { providerID, message: 'invalid api key' } } : undefined; const reply = assistantMessage(params.id, nextId(fake, 'msg'), userID, error ? '' : `COMMAND ${body.command} ARGS[${body.arguments}]`, { providerID, modelID: rest.join('/'), agent: body.agent ?? cmd.agent ?? 'build', error }); msgs.push(reply); persist(fake); return ok(reply); },
  'POST /instance/dispose': (fake) => { fake.state.f3.disposed += 1; persist(fake); return ok(true); },
};
export function withF3(scenario = {}) { return { ...scenario, data: { ...F3_DATA, ...(scenario.data ?? {}) }, setup(fake) { initF3State(fake); scenario.setup?.(fake); persist(fake); }, routes: { ...F3_SESSION_ROUTES, ...(scenario.routes ?? {}) } }; }
