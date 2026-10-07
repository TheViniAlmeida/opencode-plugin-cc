// HTTP client for the OpenCode 2.0.22 API: Basic auth, workspace header, typed errors and timeouts.
import { resolve } from 'node:path';
import { ConnectionError, NotFoundError, RequestError } from './opc-error.mjs';
import { redact, registerSecret } from './redact.mjs';

const DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function isServerDown(err) {
  const seen = new Set();
  for (let current = err; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (DOWN_CODES.has(current.code)) return true;
  }
  return false;
}

function parseBody(text) {
  if (!text) return { json: false, value: null };
  try {
    return { json: true, value: JSON.parse(text) };
  } catch {
    return { json: false, value: text };
  }
}

function safePath(path) {
  try {
    return new URL(path, 'http://opencode.invalid').pathname;
  } catch {
    return '/';
  }
}

export function createClient({
  baseUrl,
  password,
  directory,
  requestTimeoutMs = 30000,
  fetchImpl = fetch,
  onServerDown = null,
}) {
  let currentBase = String(baseUrl).replace(/\/+$/, '');
  let currentPassword = password ?? null;
  const workspaceDirectory = directory ? resolve(directory) : null;

  function registerAuthSecrets() {
    registerSecret(currentPassword);
    if (!currentPassword) return;
    const token = Buffer.from(`opencode:${currentPassword}`).toString('base64');
    registerSecret(token);
    registerSecret(`Basic ${token}`);
  }

  registerAuthSecrets();

  function authHeaders() {
    if (!currentPassword) return {};
    const token = Buffer.from(`opencode:${currentPassword}`).toString('base64');
    return { authorization: `Basic ${token}` };
  }

  function buildUrl(path, query = {}) {
    const url = new URL(currentBase + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  // `envelope: true` keeps the whole JSON body (e.g. `{ data, cursor }` of paginated lists).
  async function once(method, path, { query, body, timeoutMs, envelope = false }) {
    const label = `${method} ${safePath(path)}`;
    const controller = new AbortController();
    const limit = timeoutMs ?? requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);
    let res;
    try {
      res = await fetchImpl(buildUrl(path, query), {
        method,
        headers: { ...authHeaders(), accept: 'application/json', ...(workspaceDirectory ? { 'x-opencode-directory': workspaceDirectory } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new ConnectionError('TIMEOUT', `${label}: sem resposta em ${limit} ms.`);
      }
      if (isServerDown(err)) throw new ConnectionError('SERVER_DOWN', `${label}: servidor OpenCode inacessível.`);
      throw new RequestError('CLIENT_ERROR', `${label}: falha interna ao preparar ou executar a requisição.`, { cause: err });
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ConnectionError('TIMEOUT', `${label}: sem resposta em ${limit} ms.`);
      throw new ConnectionError('SERVER_DOWN', `${label}: conexão encerrada durante a resposta.`);
    }
    clearTimeout(timer);
    const { json, value: parsed } = parseBody(text);
    if (res.ok) {
      if (res.status === 204) return null;
      if (!json) throw new RequestError('NOT_JSON', `${label}: resposta não é JSON (servidor não é OpenCode V2?)`);
      if (envelope) return parsed;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'data') ? parsed.data : parsed;
    }
    const details = { status: res.status, body: redact(parsed) };
    if (res.status === 401) throw new ConnectionError('AUTH_FAILED', `${label}: autenticação recusada (401).`, { details });
    if (res.status === 404) throw new NotFoundError('NOT_FOUND', `${label}: não encontrado (404).`, { details });
    if (res.status >= 500) {
      throw new RequestError('SERVER_ERROR', `${label}: erro do servidor (${res.status}).`, { details });
    }
    throw new RequestError('BAD_REQUEST', `${label}: requisição recusada (${res.status}).`, { details });
  }

  async function request(method, path, { query, body, timeoutMs, retryOnServerDown, envelope } = {}) {
    const retry = retryOnServerDown ?? method === 'GET';
    try {
      return await once(method, path, { query, body, timeoutMs, envelope });
    } catch (err) {
      if (!(retry && onServerDown && err instanceof ConnectionError && err.code === 'SERVER_DOWN')) throw err;
      const next = await onServerDown();
      if (typeof next === 'string') currentBase = next.replace(/\/+$/, '');
      else if (next && typeof next === 'object') {
        if (next.url) currentBase = String(next.url).replace(/\/+$/, '');
        if (next.password) {
          currentPassword = next.password;
          registerAuthSecrets();
        }
      }
      return once(method, path, { query, body, timeoutMs, envelope });
    }
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
    authHeaders,
    buildUrl,
    get baseUrl() {
      return currentBase;
    },
    get directory() {
      return workspaceDirectory;
    },
  };
}
