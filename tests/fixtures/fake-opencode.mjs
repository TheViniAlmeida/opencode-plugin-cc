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
  } catch {
    return freshState();
  }
}

export function writeStateFile(stateFile, state) {
  if (!stateFile) return;
  const tmp = `${stateFile}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
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
  return { method, regex: new RegExp(`^${source}$`), names };
}

function matchRoute(table, method, pathname) {
  for (const [key, handler] of Object.entries(table)) {
    const route = compileRoute(key);
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { handler, params };
  }
  return null;
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
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const scenarioHit = matchRoute(scenarioRoutes, req.method, url.pathname);
    const baseHit = matchRoute(baseRoutes, req.method, url.pathname);
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
  if (typeof scn.setup === 'function') await scn.setup(fake);
  fake.close = () =>
    new Promise((resolve) => {
      for (const client of [...sseClients]) client.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  return fake;
}
