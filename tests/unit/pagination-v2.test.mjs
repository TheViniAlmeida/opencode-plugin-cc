// OpenCode 2.0.22 list paging (limit ≤ 200 + opaque cursor) and compact body, against the faithful HTTP fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { SEED, userMessage } from '../fixtures/f3-fake.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi, collectPages, MAX_PAGE_LIMIT } from '../../plugins/opc/scripts/lib/api.mjs';
import { readSessionMessages, readTurnMessages } from '../../plugins/opc/scripts/lib/session-messages.mjs';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { list } from '../../plugins/opc/scripts/commands/permissions.mjs';

const MSG = (n) => `msg_${n.toString(16).padStart(12, '0')}${String(n).padStart(14, '0')}`;

async function boot(t, { extraMessages = 0 } = {}) {
  const password = randomBytes(24).toString('hex');
  const fake = await startFake({ password, scenario: 'f3-sessions' });
  t.after(() => fake.close());
  const seeded = fake.state.messages[SEED.session];
  const older = Array.from({ length: extraMessages }, (_, i) => userMessage(SEED.session, MSG(1000 + i), `old ${i}`, i + 1));
  fake.state.messages[SEED.session] = [...older, ...seeded];
  const client = createClient({ baseUrl: fake.url, password, directory: process.cwd() });
  const raw = async (path) => {
    const res = await fetch(`${fake.url}${path}`, { headers: client.authHeaders() });
    return { status: res.status, body: await res.json() };
  };
  const messageReads = () => fake.state.requests.filter((r) => r.method === 'GET' && r.path === `/api/session/${SEED.session}/message`);
  return { fake, api: createApi(client), raw, messageReads };
}

test('fake V2 enforces limit ≤ 200 and refuses cursor combined with order', async (t) => {
  const { raw } = await boot(t);
  const tooBig = await raw(`/api/session/${SEED.session}/message?order=asc&limit=1000`);
  assert.deepEqual([tooBig.status, tooBig.body._tag, tooBig.body.message], [400, 'InvalidRequestError', 'Expected a value less than or equal to 200']);
  const first = await raw(`/api/session/${SEED.session}/message?order=asc&limit=2`);
  assert.equal(first.status, 200);
  assert.equal(typeof first.body.cursor.next, 'string');
  const mixed = await raw(`/api/session/${SEED.session}/message?order=asc&limit=2&cursor=${first.body.cursor.next}`);
  assert.deepEqual([mixed.status, mixed.body._tag, mixed.body.message], [400, 'InvalidCursorError', 'Cursor cannot be combined with order']);
  const second = await raw(`/api/session/${SEED.session}/message?limit=2&cursor=${first.body.cursor.next}`);
  assert.deepEqual(second.body.data.map((m) => m.id), [SEED.m3, SEED.m4], 'the cursor keeps the ascending order');
  const last = await raw(`/api/session/${SEED.session}/message?limit=2&cursor=${second.body.cursor.next}`);
  assert.equal(last.body.data.length, 1);
  assert.equal(typeof last.body.cursor.next, 'string', 'V2 fills cursor.next even on the last page');
  const after = await raw(`/api/session/${SEED.session}/message?limit=2&cursor=${last.body.cursor.next}`);
  assert.deepEqual([after.body.data, after.body.cursor.next], [[], null]);
  const sessions = await raw('/api/session');
  assert.ok(Array.isArray(sessions.body.data));
  assert.ok(sessions.body.cursor && 'next' in sessions.body.cursor, 'session lists carry a cursor');
});

test('messages reads every page of a long session: ascending, no duplicates, stops on the short page', async (t) => {
  const { fake, api, messageReads } = await boot(t, { extraMessages: 445 });
  const expected = fake.state.messages[SEED.session].map((m) => m.id);
  assert.equal(expected.length, 450);
  const messages = await api.messages(SEED.session);
  assert.deepEqual(messages.map((m) => m.id), expected);
  assert.equal(new Set(messages.map((m) => m.id)).size, 450);
  const reads = messageReads();
  assert.equal(reads.length, 3, '200 + 200 + 50 (short page ends the list)');
  assert.deepEqual(reads[0].query, { order: 'asc', limit: '200' });
  for (const read of reads.slice(1)) {
    assert.equal(read.query.limit, '200');
    assert.equal(typeof read.query.cursor, 'string');
    assert.equal('order' in read.query, false, 'a cursor page never repeats the order');
  }
  assert.ok(reads.every((read) => Number(read.query.limit) <= MAX_PAGE_LIMIT));
});

test('messages stops on the empty page after an exact multiple of 200', async (t) => {
  const { api, messageReads } = await boot(t, { extraMessages: 395 });
  assert.equal((await api.messages(SEED.session)).length, 400);
  assert.equal(messageReads().length, 3, '200 + 200 + empty page with next null');
});

test('a user limit is honoured across pages and readTurnMessages reads the whole session once', async (t) => {
  const { fake, api, messageReads } = await boot(t, { extraMessages: 445 });
  const ids = fake.state.messages[SEED.session].map((m) => m.id);
  assert.deepEqual((await readSessionMessages(api, SEED.session, { limit: 250 })).map((m) => m.id), ids.slice(0, 250));
  assert.equal(messageReads().length, 2);
  assert.deepEqual((await readSessionMessages(api, SEED.session, { limit: 5 })).map((m) => m.id), ids.slice(0, 5));
  assert.equal(messageReads().at(-1).query.limit, '5');
  const turn = await readTurnMessages(api, SEED.session);
  assert.equal(turn.at(-1).id, ids.at(-1));
  assert.equal(turn.length, 450);
});

test('page limits above 200 or non-positive limits are refused before any request', async (t) => {
  const { api, messageReads } = await boot(t);
  await assert.rejects(api.messagesPage(SEED.session, { limit: 201 }), { code: 'INVALID_LIMIT' });
  await assert.rejects(api.messages(SEED.session, { limit: 0 }), { code: 'INVALID_LIMIT' });
  assert.equal(messageReads().length, 0);
});

test('collectPages refuses a repeated cursor, a page without new items and endless pages', async () => {
  let calls = 0;
  const repeated = async () => { calls += 1; return { data: [{ id: `msg_${calls}` }], cursor: { next: 'same' } }; };
  await assert.rejects(collectPages(repeated, { pageSize: 1 }), { code: 'PAGINATION_LOOP' });
  assert.equal(calls, 2);
  calls = 0;
  const ignoresCursor = async () => { calls += 1; return { data: [{ id: 'msg_a' }, { id: 'msg_b' }], cursor: { next: `c${calls}` } }; };
  await assert.rejects(collectPages(ignoresCursor, { pageSize: 2 }), { code: 'PAGINATION_LOOP' });
  assert.equal(calls, 2);
  calls = 0;
  const endless = async () => { calls += 1; return { data: [{ id: `msg_${calls}` }], cursor: { next: `c${calls}` } }; };
  await assert.rejects(collectPages(endless, { pageSize: 1, maxPages: 5 }), { code: 'PAGINATION_LIMIT' });
  assert.equal(calls, 5);
});

test('listSessions and children follow the session cursor and keep only matching children', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ id: `ses_${i}`, ...(i % 2 ? { parentID: 'ses_p' } : {}) }));
  const calls = [];
  const client = {
    async get(path, opts) {
      calls.push({ path, query: opts.query ?? {}, envelope: opts.envelope });
      const start = opts.query?.cursor ? Number(opts.query.cursor) : 0;
      const data = all.slice(start, start + 2);
      return { data, cursor: { previous: null, next: data.length ? String(start + 2) : null } };
    },
  };
  const api = createApi(client);
  assert.deepEqual((await api.listSessions()).map((s) => s.id), all.map((s) => s.id));
  assert.deepEqual(calls.map((c) => c.query), [{}, { cursor: '2' }, { cursor: '4' }, { cursor: '6' }]);
  assert.ok(calls.every((c) => c.envelope === true));
  calls.length = 0;
  // The stub ignores parentID, as a cursor page might: the local filter keeps only real children.
  assert.deepEqual((await api.children('ses_p')).map((s) => s.id), ['ses_1', 'ses_3']);
  assert.deepEqual(calls[1].query, { parentID: 'ses_p', cursor: '2' });
});

test('compact posts an object body and returns the V2 compaction message', async (t) => {
  const { fake, api } = await boot(t);
  const compaction = await api.compact(SEED.session);
  assert.equal(compaction.type, 'compaction');
  assert.equal(compaction.sessionID, SEED.session);
  assert.match(compaction.id, /^msg_/);
  const request = fake.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/compact'));
  assert.deepEqual(request.body, {});
});

function pollingHub() {
  let reconnect = () => {};
  return { hub: { track: () => () => {}, onReconnect: (fn) => { reconnect = fn; return () => {}; } }, reconnect: () => reconnect() };
}

const COMMAND_MODEL = { providerID: 'omniroute-personal', modelID: 'opencode-go/deepseek-v4.1-flash' };

test('command over a session with a large history: paged baseline, only the new turn is used', async (t) => {
  const { fake, api, messageReads } = await boot(t, { extraMessages: 445 });
  const baseline = new Set(fake.state.messages[SEED.session].map((m) => m.id));
  const { hub } = pollingHub();
  const result = await runTurn({ api, hub, request: { sessionID: SEED.session, model: COMMAND_MODEL, command: { name: 'echo', text: 'hi' }, timeoutMs: 10000, statusPollMs: 20 } });
  assert.equal(result.status, 'completed', result.errorMessage);
  assert.equal(result.finalText, 'COMANDO echo ARGUMENTOS[hi]');
  assert.equal(baseline.has(result.messageID), false, 'the turn message is the new command message');
  assert.equal(fake.state.messages[SEED.session].find((m) => m.id === result.messageID).text, '/echo hi');
  assert.ok(messageReads().length >= 3);
  assert.ok(messageReads().every((read) => Number(read.query.limit) <= MAX_PAGE_LIMIT));
});

test('a refused command baseline read fails the turn without reading a null baseline', async () => {
  let commands = 0;
  const api = {
    getSession: async () => ({ agent: 'build', model: { providerID: 'p', id: 'm' } }),
    messages: async () => { throw new RequestError('BAD_REQUEST', 'GET /api/session/<id>/message: requisição recusada (400).'); },
    runCommand: async () => { commands += 1; },
    sessionStatus: async () => ({}),
    interrupt: async () => true,
    diff: async () => [],
  };
  const { hub } = pollingHub();
  const result = await runTurn({ api, hub, request: { sessionID: 'ses_test', model: { providerID: 'p', modelID: 'm' }, command: { name: 'echo', text: '' }, timeoutMs: 1000 } });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'bad_request');
  assert.equal(commands, 0);
});

test('a reconnect resync before the command baseline exists does not fail the turn', async () => {
  let onEvent;
  const messages = [{ id: 'msg_old', type: 'idle', outcome: 'succeeded' }];
  let reconnect;
  const api = {
    getSession: async () => ({ agent: 'build', model: { providerID: 'p', id: 'm' } }),
    messages: async () => messages,
    sessionStatus: async () => ({}),
    children: async () => [],
    listPermissions: async () => [],
    listQuestions: async () => [],
    runCommand: async () => {
      messages.push({ id: 'msg_user', type: 'user', text: '/echo' },
        { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: 'ready' }] },
        { id: 'msg_idle', type: 'idle', outcome: 'succeeded' });
      queueMicrotask(() => onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } }));
    },
    diff: async () => [],
  };
  const hub = { track: (_id, callback) => { onEvent = callback; return () => {}; }, onReconnect: (fn) => { reconnect = fn; return () => {}; } };
  // The reconnect resync runs (and finishes) while the session is idle and before the baseline is read.
  const onSession = async () => { await reconnect(); };
  const result = await runTurn({ api, hub, onSession, request: { sessionID: 'ses_test', model: { providerID: 'p', modelID: 'm' }, command: { name: 'echo', text: '' }, timeoutMs: 1000 } });
  assert.equal(result.status, 'completed', result.errorMessage);
  assert.equal(result.finalText, 'ready');
  assert.equal(result.messageID, 'msg_user');
});

test('permissions list finds a pending request in an OPC session beyond the first session page', async () => {
  const sessions = [...Array.from({ length: 4 }, (_, i) => ({ id: `ses_user${i}`, title: 'TUI' })), { id: 'ses_late', title: 'OPC: late' }];
  const client = {
    async get(path, opts) {
      if (path === '/api/session') {
        const start = opts.query?.cursor ? Number(opts.query.cursor) : 0;
        const data = sessions.slice(start, start + 2);
        return { data, cursor: { previous: null, next: data.length ? String(start + 2) : null } };
      }
      if (path === '/api/session/ses_late/permission') return [{ id: 'per_late', sessionID: 'ses_late', action: 'shell', resources: ['ls'], save: [], source: {} }];
      return [];
    },
  };
  const ctx = { stateDir: '/missing-state', out() {}, json: (value) => { ctx.output = value; } };
  await list(ctx, { json: true }, () => createApi(client));
  assert.deepEqual(ctx.output.requests.map((request) => request.id), ['per_late']);
});
