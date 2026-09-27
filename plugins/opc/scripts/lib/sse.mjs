// SSE /event: parser, liveness, reconnection with backoff and per-session routing incl. children (spec §5.3).
import { ConnectionError } from './opc-error.mjs';
import { redactText } from './redact.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSSEParser() {
  let buffer = '';
  return {
    push(chunkText) {
      buffer += String(chunkText);
      buffer = buffer.replace(/\r\n/g, '\n');
      const events = [];
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) {
          try {
            events.push(JSON.parse(data));
          } catch {
            // invalid JSON frames are ignored
          }
        }
        index = buffer.indexOf('\n\n');
      }
      return events;
    },
  };
}

export function eventSessionID(event) {
  const p = event?.properties;
  if (!p || typeof p !== 'object') return null;
  return p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? null;
}

function safeCall(kind, fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    const warning = new Error(redactText(err?.message ?? String(err)));
    warning.name = redactText(err?.name ?? 'Error');
    try {
      process.emitWarning(warning, { type: 'OpcEventHubHandlerError', detail: kind });
    } catch {
      // Warning reporting must not let a handler break the hub.
    }
  }
}

async function closeConnection(controller, reader) {
  controller?.abort();
  if (!reader) return;
  try {
    await reader.cancel();
  } catch {
    // The stream may already have errored or been cancelled by its abort signal.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can keep the lock until abort settles.
    }
  }
}

export class EventHub {
  constructor({ client, livenessMs = 30000, backoffMs = [500, 1000, 2000, 4000, 8000], fetchImpl = fetch }) {
    this.client = client;
    this.livenessMs = livenessMs;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl;
    this._state = 'idle';
    this._routes = new Map();
    this._any = new Set();
    this._reconnect = new Set();
    this._down = new Set();
    this._controller = null;
    this._livenessTimer = null;
    this._stopConnection = null;
  }

  get state() {
    return this._state;
  }

  onAny(handler) {
    this._any.add(handler);
    return () => this._any.delete(handler);
  }

  onReconnect(handler) {
    this._reconnect.add(handler);
    return () => this._reconnect.delete(handler);
  }

  onDown(handler) {
    this._down.add(handler);
    return () => this._down.delete(handler);
  }

  track(sessionID, handler) {
    const entry = { handler, ids: new Set([sessionID]) };
    this._routes.set(sessionID, entry);
    return () => {
      for (const id of entry.ids) if (this._routes.get(id) === entry) this._routes.delete(id);
    };
  }

  async start() {
    if (this._state !== 'idle') throw new Error('EventHub already started');
    this._state = 'connecting';
    let first;
    try {
      first = await this._connect();
    } catch (err) {
      clearTimeout(this._livenessTimer);
      this._stopConnection = null;
      if (this._state === 'stopped') throw new Error('EventHub start stopped before opening');
      if (err?.details?.disposed) {
        this._state = 'reconnecting';
        let lastError = err;
        for (const delay of this.backoffMs) {
          await sleep(delay);
          if (this._state === 'stopped') throw new Error('EventHub start stopped before opening');
          try {
            first = await this._connect();
            break;
          } catch (reconnectError) {
            lastError = reconnectError;
            if (reconnectError.code === 'AUTH_FAILED') break;
          }
        }
        if (!first) {
          if (this._state === 'stopped') throw new Error('EventHub start stopped before opening');
          this._state = 'down';
          throw lastError;
        }
        this._state = 'open';
        for (const h of this._reconnect) safeCall('onReconnect', h);
        this._loop(first);
        return;
      }
      this._state = 'idle';
      throw err;
    }
    if (this._state === 'stopped') throw new Error('EventHub start stopped before opening');
    this._state = 'open';
    this._loop(first);
  }

  stop() {
    this._state = 'stopped';
    clearTimeout(this._livenessTimer);
    if (this._controller) this._controller.abort();
    this._stopConnection?.();
  }

  _armLiveness() {
    clearTimeout(this._livenessTimer);
    this._livenessTimer = setTimeout(() => {
      if (this._controller) this._controller.abort();
    }, this.livenessMs);
    if (typeof this._livenessTimer.unref === 'function') this._livenessTimer.unref();
  }

  async _connect() {
    if (this._state === 'stopped') throw new Error('EventHub connection stopped');
    const controller = new AbortController();
    this._controller = controller;
    const startedAt = performance.now();
    const deadline = startedAt + this.livenessMs;
    let timeout;
    let stopReject;
    const stopped = new Promise((resolve, reject) => { stopReject = reject; });
    const timeoutPromise = new Promise((resolve, reject) => {
      const checkDeadline = () => {
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          timeout = setTimeout(checkDeadline, remaining);
          return;
        }
        const err = new ConnectionError('TIMEOUT', 'Tempo limite aguardando os headers do fluxo de eventos.');
        reject(err);
        controller.abort();
      };
      timeout = setTimeout(checkDeadline, this.livenessMs);
    });
    this._stopConnection = () => {
      stopReject(new Error('EventHub connection stopped'));
    };
    let res;
    let reader;
    try {
      const fetchPromise = Promise.resolve().then(() => {
        if (this._state === 'stopped') throw new Error('EventHub connection stopped');
        return this.fetchImpl(this.client.buildUrl('/event'), {
          headers: { ...this.client.authHeaders(), accept: 'text/event-stream' },
          signal: controller.signal,
        });
      });
      res = await Promise.race([fetchPromise, timeoutPromise, stopped]);
    } catch (err) {
      this._stopConnection = null;
      await closeConnection(controller);
      if (this._state === 'stopped') throw new Error('EventHub connection stopped');
      if (err?.code === 'TIMEOUT') throw err;
      throw new ConnectionError('SERVER_DOWN', 'Não foi possível abrir o fluxo de eventos (/event).');
    } finally {
      clearTimeout(timeout);
    }
    try {
      if (res.status === 401) throw new ConnectionError('AUTH_FAILED', 'Fluxo de eventos recusado (401).');
      if (!res.ok || !res.body) throw new ConnectionError('SERVER_DOWN', `Fluxo de eventos falhou (HTTP ${res.status}).`);
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      this._armLiveness();
      // Wait for the first event (server.connected) before declaring the stream open.
      for (;;) {
        let chunk;
        try {
          chunk = await Promise.race([reader.read(), stopped]);
        } catch {
          if (this._state === 'stopped') throw new Error('EventHub connection stopped');
          throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro evento.');
        }
        if (chunk.done) throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro evento.');
        const events = parser.push(decoder.decode(chunk.value, { stream: true }));
        if (events.some((event) => event?.type === 'server.instance.disposed')) {
          throw new ConnectionError('SERVER_DOWN', 'Instância do servidor descartada; reconectando o fluxo de eventos.', { details: { disposed: true } });
        }
        if (events.length > 0) {
          this._stopConnection = null;
          return { reader, decoder, parser, controller, pending: events };
        }
      }
    } catch (err) {
      this._stopConnection = null;
      await closeConnection(controller, reader);
      throw err;
    }
  }

  async _read(conn) {
    let disposed = false;
    const handle = (events) => {
      for (const event of events) {
        this._armLiveness();
        this._dispatch(event);
        if (event?.type === 'server.instance.disposed') disposed = true;
      }
    };
    handle(conn.pending);
    while (!disposed && this._state !== 'stopped') {
      let chunk;
      try {
        chunk = await conn.reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      handle(conn.parser.push(conn.decoder.decode(chunk.value, { stream: true })));
    }
    conn.controller.abort();
  }

  async _loop(first) {
    let conn = first;
    while (this._state !== 'stopped') {
      await this._read(conn);
      await closeConnection(conn.controller, conn.reader);
      clearTimeout(this._livenessTimer);
      if (this._state === 'stopped') return;
      this._state = 'reconnecting';
      conn = null;
      let lastError = null;
      for (const delay of this.backoffMs) {
        await sleep(delay);
        if (this._state === 'stopped') return;
        try {
          conn = await this._connect();
          break;
        } catch (err) {
          lastError = err;
          if (this._state === 'stopped') return;
          if (err.code === 'AUTH_FAILED') break;
        }
      }
      if (!conn) {
        if (this._state === 'stopped') return;
        this._state = 'down';
        const err = lastError?.code === 'AUTH_FAILED'
          ? lastError
          : new ConnectionError('SERVER_DOWN', `Fluxo de eventos perdido após ${this.backoffMs.length} tentativas de reconexão.`);
        for (const h of this._down) safeCall('onDown', h, err);
        return;
      }
      this._state = 'open';
      for (const h of this._reconnect) safeCall('onReconnect', h);
    }
  }

  _dispatch(event) {
    for (const h of this._any) safeCall('onAny', h, event);
    if (event?.type === 'session.created') {
      const info = event.properties?.info;
      const parent = info?.parentID ? this._routes.get(info.parentID) : null;
      if (parent && info.id && !this._routes.has(info.id)) {
        parent.ids.add(info.id);
        this._routes.set(info.id, parent);
      }
    }
    const sid = eventSessionID(event);
    const entry = sid ? this._routes.get(sid) : null;
    if (entry) safeCall('track', entry.handler, event);
  }
}
