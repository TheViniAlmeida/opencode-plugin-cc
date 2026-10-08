// Fake OpenCode 2.0.22 server (HTTP + SSE) for integration tests.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DATA_DIR = path.join(HERE, 'data');
export const SCENARIO_DIR = path.join(HERE, 'scenarios');
export const DEFAULT_VERSION = '2.0.22';

export function freshState() {
  return {
    requests: [],
    unauthorized: 0,
    sessions: {},
    messages: {},
    permissions: {},
    forms: {},
    signals: [],
    sseConnections: 0,
    bootAttempts: 0,
    boots: [],
  };
}

export function readStateFile(stateFile) {
  try {
    return { ...freshState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return freshState();
    throw new Error(`Falha ao ler estado do servidor falso: ${err.code ?? 'ERRO'}`);
  }
}

export function writeStateFile(stateFile, state) {
  if (!stateFile) return;
  const directory = path.dirname(stateFile);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted && (fs.statSync(directory).mode & 0o777) !== 0o700) {
    fs.chmodSync(directory, 0o700);
  }
  const tmp = `${stateFile}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

export async function loadScenario(name = 'ok') {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Nome de cenário inválido: ${String(name).slice(0, 12)}…`);
  const mod = await import(pathToFileURL(path.join(SCENARIO_DIR, `${name}.mjs`)).href);
  return mod.default ?? {};
}

export function readFixture(dataDir, name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
}

const newEventId = () => `evt_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;

function compileRoute(key) {
  const [method, pattern] = key.split(' ');
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const segments = pattern.split('/').filter(Boolean);
  return {
    method,
    regex: new RegExp(`^${source}$`),
    names,
    staticSegments: segments.filter((seg) => !seg.startsWith(':')).length,
  };
}

export function matchRoute(table, method, pathname) {
  const candidates = Object.entries(table)
    .map(([key, handler], index) => ({ key, handler, route: compileRoute(key), index }))
    .filter(({ route }) => route.method === method)
    .sort((a, b) => {
      const aStatic = a.route.names.length === 0;
      const bStatic = b.route.names.length === 0;
      if (aStatic !== bStatic) return aStatic ? -1 : 1;
      return b.route.staticSegments - a.route.staticSegments || a.index - b.index;
    });
  for (const { handler, route } of candidates) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { handler, params, route };
  }
  return null;
}

// Higher is more specific: a static pattern beats any parametrized one, then more static segments win.
export function routeSpecificity(route) {
  return (route.names.length === 0 ? 1000 : 0) + route.staticSegments;
}

function safeConfigInfo(content) {
  try {
    const source = JSON.parse(content ?? '{}');
    const info = {};
    for (const key of ['share', 'model', 'small_model', 'agent']) {
      if (typeof source?.[key] === 'string') info[key] = source[key];
      // V2 normalizes model fields to { providerID, model }; the fake echoes that form when the content declares it.
      else if (key.endsWith('model') && typeof source?.[key]?.providerID === 'string' && typeof source[key].model === 'string') {
        info[key] = { providerID: source[key].providerID, model: source[key].model };
      }
    }
    if (typeof source?.snapshot === 'boolean') info.snapshot = source.snapshot;
    // Provider ids only: provider settings may carry credentials and the catalog tests need just the declaration.
    // The real V2 reports them under `providers` (plural); the content may declare either spelling.
    const declared = source?.providers ?? source?.provider;
    if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
      info.providers = Object.fromEntries(Object.keys(declared).map((id) => [id, {}]));
    }
    return info;
  } catch {
    return {};
  }
}

// Request history is persisted. Free-form content may contain secrets even without a sensitive key.
const SENSITIVE_BODY_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;
const FREE_FORM_BODY_KEY = /^(?:text|note|prompt|message|description|content)$/i;

export function safeRequestBody(body) {
  if (Array.isArray(body)) return body.map(safeRequestBody);
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, SENSITIVE_BODY_KEY.test(key) || FREE_FORM_BODY_KEY.test(key) ? '[REDACTED]' : safeRequestBody(value)]));
}

export const DEFAULT_ROUTES = {
  'GET /api/info': (fake) => ({ body: { version: fake.version, pid: process.pid, urls: [fake.url], paths: { tmp: '<tmp>' } } }),
  'GET /api/model/default': () => ({ body: { data: { id: 'opencode-go/deepseek-v4.1-flash', modelID: 'opencode-go/deepseek-v4.1-flash', providerID: 'omniroute-personal' } } }),
  'GET /api/event': (fake, ctx) => {
    fake.openEventStream(ctx.req, ctx.res);
    return 'handled';
  },
};

// Phase extensions: F1+ append `registerFakeExtension(install)` calls at the END of this file (never edit the
// router). `install(fake)` runs once per startFake, before the scenario `setup`, and returns a route table
// `{ 'METHOD /path/:param': handler }` merged over DEFAULT_ROUTES (same key → replaced; new keys → appended).
const FAKE_EXTENSIONS = [];
export function registerFakeExtension(install) {
  FAKE_EXTENSIONS.push(install);
}

export async function startFake({
  port = 0,
  password = null,
  scenario = 'ok',
  stateFile = null,
  dataDir = FIXTURE_DATA_DIR,
  heartbeatMs = Number(process.env.FAKE_HEARTBEAT_MS || 15000),
  version = process.env.FAKE_OPENCODE_VERSION || DEFAULT_VERSION,
  configContent = process.env.OPENCODE_CONFIG_CONTENT,
} = {}) {
  const scn = await loadScenario(scenario);
  const state = stateFile ? readStateFile(stateFile) : freshState();
  const sseClients = new Set();

  const fake = {
    state,
    stateFile,
    dataDir,
    scenario: scn,
    scenarioName: scenario,
    version: scn.version ?? version,
    password,
    rejectAllAuth: false,
    heartbeatMs,
    configOverride: safeConfigInfo(configContent),
    sseClients,
    persist() {
      writeStateFile(stateFile, state);
    },
    recordSignal(signal) {
      state.signals.push({ signal, pid: process.pid, at: Date.now() });
      writeStateFile(stateFile, state);
    },
    emit(event) {
      const directory = state.sessions?.[event.data?.sessionID]?.location?.directory ?? '<workspace>';
      const full = { id: newEventId(), created: Date.now(), location: { directory }, ...event };
      if (!full.data) full.data = {};
      for (const client of sseClients) client.send(full);
    },
    openEventStream(req, res) {
      state.sseConnections += 1;
      writeStateFile(stateFile, state);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders?.();
      let heartbeat = null;
      const stream = {
        index: state.sseConnections,
        send(event) {
          const full = event.id ? event : { id: newEventId(), created: Date.now(), location: { directory: '<workspace>' }, type: event.type, data: event.data ?? {} };
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(full)}\n\n`);
        },
        sendConnected() {
          stream.send({ type: 'server.connected', data: {} });
          // V2 announces the loaded catalog once per instance bootstrap; opc's boot waits for it.
          if (!fake.catalogAnnounced) {
            fake.catalogAnnounced = true;
            stream.send({ type: 'model.updated', data: {} });
          }
        },
        startHeartbeat() {
          heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, fake.heartbeatMs);
        },
        close() {
          clearInterval(heartbeat);
          sseClients.delete(stream);
          if (!res.writableEnded) res.end();
          res.socket?.destroy();
        },
      };
      sseClients.add(stream);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(stream);
      });
      if (typeof scn.onEventStream === 'function') scn.onEventStream(fake, stream);
      else {
        stream.sendConnected();
        stream.startHeartbeat();
      }
    },
  };

  // Resolution: scenario routes first; a scenario handler returning undefined falls through to the base route
  // (DEFAULT_ROUTES + phase extensions) that matches the same request, params included.
  const baseRoutes = { ...DEFAULT_ROUTES };
  for (const install of FAKE_EXTENSIONS) Object.assign(baseRoutes, install(fake) ?? {});
  const scenarioRoutes = scn.routes ?? {};

  function authorized(req) {
    if (fake.rejectAllAuth) return false;
    if (!fake.password) return true;
    const expected = `Basic ${Buffer.from(`opencode:${fake.password}`).toString('base64')}`;
    return req.headers.authorization === expected;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>OpenCode</body></html>');
      return;
    }
    if (!authorized(req)) {
      state.unauthorized = (state.unauthorized ?? 0) + 1;
      writeStateFile(stateFile, state);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const directory = req.headers['x-opencode-directory'] ?? url.searchParams.get('location[directory]') ?? null;
    state.requests.push({ method: req.method, path: url.pathname, query, body: safeRequestBody(body), directory, at: Date.now() });
    writeStateFile(stateFile, state);
    if (directory && !path.isAbsolute(directory)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'InvalidLocationError', message: 'Diretório precisa ser absoluto' }));
      return;
    }
    let scenarioHit = matchRoute(scenarioRoutes, req.method, url.pathname);
    const baseHit = matchRoute(baseRoutes, req.method, url.pathname);
    // A scenario route only shadows a base route that is not more specific (e.g. scenario
    // A parameter route must not capture a more specific static API route.
    if (scenarioHit && baseHit && routeSpecificity(baseHit.route) > routeSpecificity(scenarioHit.route)) scenarioHit = null;
    if (!scenarioHit && !baseHit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'NotFoundError', message: 'Rota da API não encontrada' }));
      return;
    }
    const routeCtx = (hit) => ({ method: req.method, path: url.pathname, query, body, directory, params: hit.params, req, res });
    try {
      let final = scenarioHit ? await scenarioHit.handler(fake, routeCtx(scenarioHit)) : undefined;
      if (final === 'handled') return;
      if (final === undefined && baseHit) final = await baseHit.handler(fake, routeCtx(baseHit));
      if (final === 'handled') return;
      const status = final?.status ?? 200;
      if (final?.body === undefined || status === 204) {
        res.writeHead(status === 200 ? 204 : status);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...(final.headers ?? {}) });
      res.end(JSON.stringify(final.body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _tag: 'UnknownError', message: 'Falha no servidor falso' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  fake.port = actualPort;
  fake.url = `http://127.0.0.1:${actualPort}`;
  fake.server = server;
  fake.close = () =>
    new Promise((resolve) => {
      for (const client of [...sseClients]) client.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  try {
    if (typeof scn.setup === 'function') await scn.setup(fake);
  } catch (err) {
    await fake.close();
    throw err;
  }
  return fake;
}

// ---- F1: data-driven discovery routes (fixtures in tests/fixtures/data; scenarios override with `data`) ----
// Scenario modules may export `data: { '<file>.json': value | (base) => value }` to override fixture responses.
export function loadFixtureData(name, { dataDir = FIXTURE_DATA_DIR, scenario = null } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  const override = scenario?.data?.[name];
  if (override === undefined) return base;
  return typeof override === 'function' ? override(base) : override;
}

export const F1_DATA_ROUTES = Object.freeze({
  'GET /api/provider': 'provider.json',
  'GET /api/model': 'model.json',
  'GET /api/agent': 'agent.json',
  'GET /api/command': 'command.json',
  'GET /api/skill': 'skill.json',
  'GET /api/config': 'config.json',
});

registerFakeExtension(() => Object.fromEntries(Object.entries(F1_DATA_ROUTES).map(([key, file]) => [key, (fake) => {
  const data = loadFixtureData(file, { dataDir: fake.dataDir, scenario: fake.scenario });
  if (file === 'config.json') return { body: Object.keys(fake.configOverride).length ? [...data, { type: 'document', info: fake.configOverride }] : data };
  return { body: { data } };
}])));
// ---- end F1 ----

// ---- F2a: session, prompt, permission and question API (tests/fixtures/fake-session-api.mjs) ----
import { SESSION_API_ROUTES, installSessionApi } from './fake-session-api.mjs';

registerFakeExtension((fake) => {
  const api = installSessionApi(fake);
  const handler = (_fake, { method, path: pathname, query, body, directory }) =>
    api.handle(method, pathname, new URLSearchParams(query), body, directory)
    ?? { status: 404, body: { _tag: 'NotFoundError', message: 'Rota da API não encontrada' } };
  return Object.fromEntries(SESSION_API_ROUTES.map((key) => [key, handler]));
});
// ---- end F2a ----
