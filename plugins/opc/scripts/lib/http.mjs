// HTTP client for the OpenCode API v1: Basic auth, ?directory, typed errors, timeouts, redaction (spec §5.2).
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
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
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
  username = 'opencode',
  directory,
  requestTimeoutMs = 30000,
  fetchImpl = fetch,
  onServerDown = null,
}) {
  let currentBase = String(baseUrl).replace(/\/+$/, '');
  let currentPassword = password ?? null;

  function registerAuthSecrets() {
    registerSecret(currentPassword);
    if (!currentPassword) return;
    const token = Buffer.from(`${username}:${currentPassword}`).toString('base64');
    registerSecret(token);
    registerSecret(`Basic ${token}`);
  }

  registerAuthSecrets();

  function authHeaders() {
    if (!currentPassword) return {};
    const token = Buffer.from(`${username}:${currentPassword}`).toString('base64');
    return { authorization: `Basic ${token}` };
  }

  function buildUrl(path, query = {}) {
    const url = new URL(currentBase + path);
    const params = { ...(directory && query.directory === undefined ? { directory } : {}), ...query };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function once(method, path, { query, body, timeoutMs }) {
    const label = `${method} ${safePath(path)}`;
    const controller = new AbortController();
    const limit = timeoutMs ?? requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);
    let res;
    try {
      res = await fetchImpl(buildUrl(path, query), {
        method,
        headers: { ...authHeaders(), accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    const parsed = parseBody(text);
    if (res.ok) return res.status === 204 ? null : parsed;
    const details = { status: res.status, body: redact(parsed) };
    if (res.status === 401) throw new ConnectionError('AUTH_FAILED', `${label}: autenticação recusada (401).`, { details });
    if (res.status === 404) throw new NotFoundError('NOT_FOUND', `${label}: não encontrado (404).`, { details });
    if (res.status >= 500) {
      throw new RequestError('SERVER_ERROR', `${label}: erro do servidor (${res.status}).`, { details });
    }
    throw new RequestError('BAD_REQUEST', `${label}: requisição recusada (${res.status}).`, { details });
  }

  async function request(method, path, { query, body, timeoutMs, retryOnServerDown } = {}) {
    const retry = retryOnServerDown ?? method === 'GET';
    try {
      return await once(method, path, { query, body, timeoutMs });
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
      return once(method, path, { query, body, timeoutMs });
    }
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    authHeaders,
    buildUrl,
    get baseUrl() {
      return currentBase;
    },
    get directory() {
      return directory;
    },
  };
}
