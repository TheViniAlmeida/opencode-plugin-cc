import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFake } from '../fixtures/fake-opencode.mjs';
import { makeTempDir } from '../helpers.mjs';

const PASSWORD = 'f2a-fake-session-password-0000';
const AUTH = { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` };

async function openFake(t, scenario) {
  const fake = await startFake({ port: 0, password: PASSWORD, scenario, stateFile: join(makeTempDir(), 'state.json') });
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    fake.close();
  });
  const events = [];
  const response = await fetch(`${fake.url}/event`, { headers: AUTH, signal: controller.signal });
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

test('fake session API: create, prompt_async (204), turn events, messages, status', async (t) => {
  const { call, waitEvent } = await openFake(t, 'ok');
  const bad = await call('POST', '/session', { title: 'x', share: true });
  assert.equal(bad.status, 400);
  const session = (await call('POST', '/session', { title: 'OPC: task: t', permission: [{ permission: '*', pattern: '*', action: 'deny' }] })).body;
  assert.match(session.id, /^ses_/);
  const prompt = await call('POST', `/session/${session.id}/prompt_async`, { messageID: 'msg_0000000000000000000000abcd', model: { providerID: 'p', modelID: 'm/x' }, parts: [{ type: 'text', text: 'hi' }] });
  assert.equal(prompt.status, 204);
  await waitEvent((e) => e.type === 'session.idle' && e.properties.sessionID === session.id);
  const messages = (await call('GET', `/session/${session.id}/message?limit=10`)).body;
  assert.equal(messages[0].info.id, 'msg_0000000000000000000000abcd');
  assert.equal(messages[1].info.parentID, 'msg_0000000000000000000000abcd');
  assert.equal(messages[1].parts.at(-1).text, 'fake-opencode: ok');
  assert.deepEqual((await call('GET', '/session/status')).body, {});
});

test('fake session API: PATCH appends permission rules (as OpenCode 1.18.32)', async (t) => {
  const { call } = await openFake(t, 'ok');
  const a = [{ permission: 'bash', pattern: '*', action: 'deny' }];
  const b = [{ permission: 'edit', pattern: '*', action: 'deny' }];
  const session = (await call('POST', '/session', { title: 't', permission: a })).body;
  const patched = (await call('PATCH', `/session/${session.id}`, { permission: b })).body;
  assert.deepEqual(patched.permission, [...a, ...b]);
});

test('fake session API: reject rejects the sibling; always stays accepted by the fake (the client refuses it)', async (t) => {
  const { call, waitEvent, fake } = await openFake(t, 'reject-siblings');
  const session = (await call('POST', '/session', { title: 't' })).body;
  await call('POST', `/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'go' }] });
  const asked = await waitEvent((e) => e.type === 'permission.asked' && e.properties.permission === 'edit');
  assert.equal(asked.length, 1);
  const pending = (await call('GET', '/permission')).body;
  assert.equal(pending.length, 2);
  assert.equal((await call('POST', `/permission/${pending[0].id}/reply`, { reply: 'reject' })).status, 200);
  const replied = await waitEvent((e) => e.type === 'permission.replied' && e.properties.requestID === pending[1].id);
  assert.equal(replied[0].properties.reply, 'reject');
  await waitEvent((e) => e.type === 'session.idle');
  assert.equal(fake.state.permissionReplies.length, 2);
});

test('fake session API: question reply validates string[][]; abort ends a busy turn with MessageAbortedError', async (t) => {
  const { call, waitEvent } = await openFake(t, 'question-ask');
  const session = (await call('POST', '/session', { title: 't' })).body;
  await call('POST', `/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'ask' }] });
  const [asked] = await waitEvent((e) => e.type === 'question.asked');
  assert.equal((await call('POST', `/question/${asked.properties.id}/reply`, { answers: ['Postgres'] })).status, 400);
  assert.equal((await call('POST', `/session/${session.id}/abort`)).status, 200);
  await waitEvent((e) => e.type === 'session.idle');
  const messages = (await call('GET', `/session/${session.id}/message`)).body;
  assert.equal(messages.at(-1).info.error.name, 'MessageAbortedError');
});

test('fake session API: abort during retry settles the scenario and prevents recovery messages', async (t) => {
  const { call, waitEvent } = await openFake(t, 'retry-status');
  const session = (await call('POST', '/session', { title: 'retry abort' })).body;
  await call('POST', `/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'retry' }] });
  await waitEvent((e) => e.type === 'session.status' && e.properties.sessionID === session.id && e.properties.status.type === 'retry');
  await call('POST', `/session/${session.id}/abort`);
  await waitEvent((e) => e.type === 'session.idle' && e.properties.sessionID === session.id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const messages = (await call('GET', `/session/${session.id}/message`)).body;
  const aborted = messages.filter((m) => m.info.error?.name === 'MessageAbortedError');
  assert.equal(aborted.length, 1);
  assert.equal(messages.filter((m) => m.info.role === 'assistant').length, 1);
  assert.deepEqual((await call('GET', '/session/status')).body, {});
});
