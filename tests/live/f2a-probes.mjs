// F2a live probes for specification §15 items 3 and 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_MODEL, LIVE_SKIP, liveApi, liveSetup, opcLive, report } from './_f2a-helpers.mjs';
import { PATCH_PERMISSION_MODE } from '../../plugins/opc/scripts/lib/policy.mjs';
import { newMessageId } from '../../plugins/opc/scripts/lib/runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [providerID, ...modelParts] = LIVE_MODEL.split('/');
const model = { providerID, id: modelParts.join('/') };
const rules = [{ action: '*', resource: '*', effect: 'deny' }];

async function bootServer(ctx) {
  const r = await opcLive(ctx, ['providers', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return liveApi(ctx);
}

test('live probe §15.3: PATCH /api/session/:id permissions semantics', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const first = [{ action: 'shell', resource: '*', effect: 'deny' }];
  const second = [{ action: 'edit', resource: '*', effect: 'deny' }];
  const session = await api.createSession({ title: 'OPC: probe: patch permission', model, permissions: first });
  await api.setPermissions(session.id, second);
  const after = await api.getSession(session.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mode = same(after.permissions, second) ? 'replace'
    : same(after.permissions, [...first, ...second]) ? 'append'
      : 'other';
  console.log(`LIVE-ANSWER §15.3 PATCH permissions mode = ${mode}; stored = ${JSON.stringify(after.permissions)}`);
  assert.notEqual(mode, 'other');
  assert.equal(mode, PATCH_PERMISSION_MODE, 'PATCH_PERMISSION_MODE must match the observed OpenCode behavior');
  report('sonda PATCH permission', true, mode);
});

test('live probe §15.6: client messageID format accepted by V2 prompt', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const session = await api.createSession({ title: 'OPC: probe: messageID', model, permissions: rules });
  const messageID = newMessageId();
  await api.prompt(session.id, { id: messageID, text: 'Reply with the single word OK.' });
  let messages = [];
  for (let i = 0; i < 120; i += 1) {
    messages = await api.messages(session.id, { limit: 20 });
    const userIndex = messages.findIndex((m) => m.type === 'user' && m.id === messageID);
    const reply = messages.slice(userIndex + 1).find((m) => m.type === 'assistant' && m.time?.completed);
    if (reply) break;
    await sleep(1000);
  }
  const userIndex = messages.findIndex((m) => m.type === 'user' && m.id === messageID);
  const user = messages[userIndex];
  const reply = messages.slice(userIndex + 1).find((m) => m.type === 'assistant');
  console.log(`LIVE-ANSWER §15.6 messageID ${messageID}: user message stored = ${Boolean(user)}; assistant follows = ${Boolean(reply)}`);
  let malformedAccepted = false;
  let other = null;
  try {
    other = await api.createSession({ title: 'OPC: probe: malformed messageID', model, permissions: rules });
    await api.prompt(other.id, { id: 'msg_not-a-real-id', text: 'Reply OK.' });
    malformedAccepted = true;
  } catch {
    malformedAccepted = false;
  }
  if (malformedAccepted && other) await api.interrupt(other.id);
  console.log(`LIVE-ANSWER §15.6 malformed messageID: ${malformedAccepted ? 'accepted' : 'rejected'}`);
  assert.ok(user, 'client messageID must be kept as the user message id');
  assert.ok(reply, 'assistant must follow the client messageID');
  report('sonda messageID', true, messageID);
});
