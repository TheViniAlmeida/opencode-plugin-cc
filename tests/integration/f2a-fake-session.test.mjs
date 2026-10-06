import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';

const PASSWORD = 'f2a-fake-session-password-0000';
const AUTH = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` };

async function openFake(t, scenario) {
  const fake = await startFake({ port: 0, password: PASSWORD, scenario, stateFile: join(trackTempDir(t, makeTempDir()), 'state.json') });
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    fake.close();
  });
  const events = [];
  const response = await fetch(`${fake.url}/api/event`, { headers: AUTH, signal: controller.signal });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      // aborted at the end of the test
    }
  })();
  const call = async (method, path, body) => {
    const res = await fetch(`${fake.url}${path}`, { method, headers: { ...AUTH, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const waitEvent = async (predicate, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = events.filter(predicate);
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('event not seen');
  };
  return { fake, call, events, waitEvent };
}

const MODEL = { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' };
const RULES = [{ action: '*', resource: '*', effect: 'deny' }];
const sessionBody = (title = 'OPC: task: t', permissions = RULES) => ({ title, model: MODEL, permissions });

test('fake V2 session API: create, prompt, turn events, messages, status', async (t) => {
  const { call, waitEvent } = await openFake(t, 'ok');
  const bad = await call('POST', '/api/session', { title: 'x' });
  assert.equal(bad.status, 400);
  const session = (await call('POST', '/api/session', sessionBody())).body.data;
  assert.match(session.id, /^ses_/);
  const prompt = await call('POST', `/api/session/${session.id}/prompt`, { id: 'msg_0000000000000000000000abcd', text: 'hi' });
  assert.equal(prompt.status, 200);
  await waitEvent((e) => e.type === 'session.execution.succeeded' && e.data.sessionID === session.id);
  const messages = (await call('GET', `/api/session/${session.id}/message?order=asc&limit=10`)).body.data;
  assert.equal(messages[0].id, 'msg_0000000000000000000000abcd');
  assert.equal(messages[1].content.at(-1).text, 'ok');
  assert.equal(messages.at(-1).outcome, 'succeeded');
  assert.deepEqual((await call('GET', '/api/session/active')).body.data, {});
});

test('fake V2 session API: PATCH replaces permission rules', async (t) => {
  const { call } = await openFake(t, 'ok');
  const a = [{ action: 'shell', resource: '*', effect: 'deny' }];
  const b = [{ action: 'edit', resource: '*', effect: 'deny' }];
  const session = (await call('POST', '/api/session', sessionBody('OPC: t', a))).body.data;
  assert.equal((await call('PATCH', `/api/session/${session.id}`, { permissions: b })).status, 204);
  assert.deepEqual((await call('GET', `/api/session/${session.id}`)).body.data.permissions, b);
});

test('fake session API: reject rejects the sibling; always stays accepted by the fake (the client refuses it)', async (t) => {
  const { call, waitEvent, fake } = await openFake(t, 'reject-siblings');
  const session = (await call('POST', '/api/session', sessionBody())).body.data;
  await call('POST', `/api/session/${session.id}/prompt`, { text: 'go' });
  const asked = await waitEvent((e) => e.type === 'permission.asked' && e.data.action === 'edit');
  assert.equal(asked.length, 1);
  const pending = (await call('GET', `/api/session/${session.id}/permission`)).body.data;
  assert.equal(pending.length, 2);
  assert.equal((await call('POST', `/api/session/${session.id}/permission/${pending[0].id}/reply`, { decision: 'reject' })).status, 204);
  const replied = await waitEvent((e) => e.type === 'permission.replied' && e.data.requestID === pending[0].id);
  assert.equal(replied[0].data.reply, 'reject');
  assert.equal(fake.state.permissionReplies.length, 2);
  assert.equal((await call('GET', `/api/session/${session.id}/permission`)).body.data.length, 0);
  assert.equal((await call('POST', `/api/session/${session.id}/permission/${pending[1].id}/reply`, { decision: 'once' })).status, 404);
  await waitEvent((e) => e.type === 'session.execution.succeeded');
});

test('fake V2 session API: form reply validates answer object; interrupt ends busy turn', async (t) => {
  const { call, waitEvent } = await openFake(t, 'question-ask');
  const session = (await call('POST', '/api/session', sessionBody())).body.data;
  await call('POST', `/api/session/${session.id}/prompt`, { text: 'ask' });
  const [asked] = await waitEvent((e) => e.type === 'form.created');
  assert.equal((await call('POST', `/api/session/${session.id}/form/${asked.data.form.id}/reply`, { answer: ['Postgres'] })).status, 400);
  assert.equal((await call('POST', `/api/session/${session.id}/interrupt`)).body.interrupted, true);
  await waitEvent((e) => e.type === 'session.execution.interrupted');
  const messages = (await call('GET', `/api/session/${session.id}/message?order=asc`)).body.data;
  assert.equal(messages.at(-1).outcome, 'interrupted');
});

test('fake V2 session API: interrupt during retry prevents recovery messages', async (t) => {
  const { call, waitEvent } = await openFake(t, 'retry-status');
  const session = (await call('POST', '/api/session', sessionBody('OPC: retry abort'))).body.data;
  await call('POST', `/api/session/${session.id}/prompt`, { text: 'retry' });
  await waitEvent((e) => e.type === 'session.retry.scheduled' && e.data.sessionID === session.id);
  await call('POST', `/api/session/${session.id}/interrupt`);
  await waitEvent((e) => e.type === 'session.execution.interrupted' && e.data.sessionID === session.id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const messages = (await call('GET', `/api/session/${session.id}/message?order=asc`)).body.data;
  assert.equal(messages.at(-1).outcome, 'interrupted');
  assert.equal(messages.filter((m) => m.type === 'assistant').length, 0);
  assert.deepEqual((await call('GET', '/api/session/active')).body.data, {});
});
