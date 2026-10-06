// SSE /api/event: parser, liveness, reconnection with backoff and per-session routing incl. children.
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
      let comments = 0;
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        comments += frame.split('\n').filter((line) => line.startsWith(':')).length;
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
      return { events, comments };
    },
  };
}

export function eventSessionID(event) {
  return event?.data?.sessionID ?? null;
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
    if (this._state !== 'idle') throw new Error('O hub de eventos já foi iniciado.');
    this._state = 'connecting';
    let first;
    try {
      first = await this._connect();
    } catch (err) {
      clearTimeout(this._livenessTimer);
      this._stopConnection = null;
      if (this._state === 'stopped') throw new Error('O hub de eventos parou antes de abrir.');
      this._state = 'idle';
      throw err;
    }
    if (this._state === 'stopped') throw new Error('O hub de eventos parou antes de abrir.');
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
    if (this._state === 'stopped') throw new Error('A conexão do hub de eventos foi encerrada.');
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
      stopReject(new Error('A conexão do hub de eventos foi encerrada.'));
    };
    let res;
    let reader;
    try {
      const fetchPromise = Promise.resolve().then(() => {
        if (this._state === 'stopped') throw new Error('A conexão do hub de eventos foi encerrada.');
        return this.fetchImpl(this.client.buildUrl('/api/event'), {
          headers: { ...this.client.authHeaders(), ...(this.client.directory ? { 'x-opencode-directory': this.client.directory } : {}), accept: 'text/event-stream' },
          signal: controller.signal,
        });
      });
      res = await Promise.race([fetchPromise, timeoutPromise, stopped]);
    } catch (err) {
      this._stopConnection = null;
      await closeConnection(controller);
      if (this._state === 'stopped') throw new Error('A conexão do hub de eventos foi encerrada.');
      if (err?.code === 'TIMEOUT') throw err;
      throw new ConnectionError('SERVER_DOWN', 'Não foi possível abrir o fluxo de eventos (/api/event).');
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
      // Any event or heartbeat confirms that the stream is open.
      for (;;) {
        let chunk;
        try {
          chunk = await Promise.race([reader.read(), stopped]);
        } catch {
          if (this._state === 'stopped') throw new Error('A conexão do hub de eventos foi encerrada.');
          throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro sinal.');
        }
        if (chunk.done) throw new ConnectionError('SERVER_DOWN', 'Fluxo de eventos encerrado antes do primeiro sinal.');
        const { events, comments } = parser.push(decoder.decode(chunk.value, { stream: true }));
        if (events.length > 0 || comments > 0) {
          this._armLiveness();
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
    const handle = ({ events, comments }) => {
      if (comments > 0) this._armLiveness();
      for (const event of events) {
        this._armLiveness();
        this._dispatch(event);
      }
    };
    handle({ events: conn.pending, comments: 0 });
    while (this._state !== 'stopped') {
      let chunk;
      try {
        chunk = await conn.reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      handle(conn.parser.push(conn.decoder.decode(chunk.value, { stream: true })));
    }
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
      const data = event.data;
      const parent = data?.parentID ? this._routes.get(data.parentID) : null;
      if (parent && data.sessionID && !this._routes.has(data.sessionID)) {
        parent.ids.add(data.sessionID);
        this._routes.set(data.sessionID, parent);
      }
    }
    const sid = eventSessionID(event);
    const entry = sid ? this._routes.get(sid) : null;
    if (entry) safeCall('track', entry.handler, event);
  }
}
