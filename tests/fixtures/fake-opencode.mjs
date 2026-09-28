// Fake OpenCode 1.18.32 server (HTTP + SSE) for integration tests. Phases add routes and scenarios.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DATA_DIR = path.join(HERE, 'data');
export const SCENARIO_DIR = path.join(HERE, 'scenarios');
export const DEFAULT_VERSION = '1.18.32';

export function freshState() {
  return {
    requests: [],
    unauthorized: 0,
    sessions: {},
    messages: {},
    permissions: {},
    questions: {},
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
    throw new Error(`failed to read fake state file ${stateFile}: ${err.message}`, { cause: err });
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
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid scenario name: ${name}`);
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

function parseConfigContent(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const DEFAULT_ROUTES = {
  'GET /global/health': (fake) => ({ body: { healthy: true, version: fake.version } }),
  'POST /global/dispose': () => ({ body: true }),
  'GET /agent': (fake) => ({ body: readFixture(fake.dataDir, 'agent') }),
  'GET /config': (fake) => ({ body: { ...fake.baseConfig, ...fake.configOverride } }),
  'GET /session/status': () => ({ body: {} }),
  'GET /permission': () => ({ body: [] }),
  'GET /question': () => ({ body: [] }),
  'GET /event': (fake, ctx) => {
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
  heartbeatMs = Number(process.env.FAKE_HEARTBEAT_MS || 10000),
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
    baseConfig: readFixture(dataDir, 'config'),
    configOverride: parseConfigContent(configContent),
    sseClients,
    persist() {
      writeStateFile(stateFile, state);
    },
    recordSignal(signal) {
      state.signals.push({ signal, pid: process.pid, at: Date.now() });
      writeStateFile(stateFile, state);
    },
    emit(event) {
      const full = { id: newEventId(), properties: {}, ...event };
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
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ id: newEventId(), properties: {}, ...event })}\n\n`);
        },
        sendConnected() {
          stream.send({ type: 'server.connected', properties: {} });
        },
        startHeartbeat() {
          heartbeat = setInterval(() => stream.send({ type: 'server.heartbeat', properties: {} }), fake.heartbeatMs);
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
    if (!authorized(req)) {
      state.unauthorized = (state.unauthorized ?? 0) + 1;
      writeStateFile(stateFile, state);
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
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
    state.requests.push({ method: req.method, path: url.pathname, query, body, at: Date.now() });
    writeStateFile(stateFile, state);
    let scenarioHit = matchRoute(scenarioRoutes, req.method, url.pathname);
    const baseHit = matchRoute(baseRoutes, req.method, url.pathname);
    // A scenario route only shadows a base route that is not more specific (e.g. scenario
    // 'GET /session/:id' must not capture the base 'GET /session/status').
    if (scenarioHit && baseHit && routeSpecificity(baseHit.route) > routeSpecificity(scenarioHit.route)) scenarioHit = null;
    if (!scenarioHit && !baseHit) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'NotFoundError', data: { message: `no route ${req.method} ${url.pathname}` } }));
      return;
    }
    const routeCtx = (hit) => ({ method: req.method, path: url.pathname, query, body, params: hit.params, req, res });
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
      res.end(JSON.stringify({ name: 'UnknownError', data: { message: String(err?.message ?? err) } }));
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
  'GET /provider': 'provider.json',
  'GET /agent': 'agent.json',
  'GET /command': 'command.json',
  'GET /skill': 'skill.json',
  'GET /config': 'config.json',
});

registerFakeExtension(() => Object.fromEntries(Object.entries(F1_DATA_ROUTES).map(([key, file]) => [key, (fake) => {
  const data = loadFixtureData(file, { dataDir: fake.dataDir, scenario: fake.scenario });
  // GET /config keeps the F0 contract: OPENCODE_CONFIG_CONTENT (configOverride) is merged over the file.
  return { body: file === 'config.json' ? { ...data, ...fake.configOverride } : data };
}])));
// ---- end F1 ----

// ---- F2a: session, prompt, permission and question API (tests/fixtures/fake-session-api.mjs) ----
import { SESSION_API_ROUTES, installSessionApi } from './fake-session-api.mjs';

registerFakeExtension((fake) => {
  const api = installSessionApi(fake);
  const handler = (_fake, { method, path: pathname, query, body }) =>
    api.handle(method, pathname, new URLSearchParams(query), body)
    ?? { status: 404, body: { name: 'NotFoundError', data: { message: `no route ${method} ${pathname}` } } };
  return Object.fromEntries(SESSION_API_ROUTES.map((key) => [key, handler]));
});
// ---- end F2a ----
