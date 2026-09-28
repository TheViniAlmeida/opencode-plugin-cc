// F2a live probes for specification §15 items 3 and 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_MODEL, LIVE_SKIP, liveApi, liveSetup, opcLive, report } from './_f2a-helpers.mjs';
import { PATCH_PERMISSION_MODE } from '../../plugins/opc/scripts/lib/policy.mjs';
import { newMessageId } from '../../plugins/opc/scripts/lib/runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bootServer(ctx) {
  const r = await opcLive(ctx, ['providers', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return liveApi(ctx);
}

test('live probe §15.3: PATCH /session/:id permission semantics', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const first = [{ permission: 'bash', pattern: '*', action: 'deny' }];
  const second = [{ permission: 'edit', pattern: '*', action: 'deny' }];
  const session = await api.createSession({ title: 'OPC: probe: patch permission', permission: first });
  await api.patchSession(session.id, { permission: second });
  const after = await api.getSession(session.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mode = same(after.permission, second) ? 'replace'
    : same(after.permission, [...first, ...second]) ? 'append'
      : 'other';
  console.log(`LIVE-ANSWER §15.3 PATCH permission mode = ${mode}; stored = ${JSON.stringify(after.permission)}`);
  assert.notEqual(mode, 'other');
  assert.equal(mode, PATCH_PERMISSION_MODE, 'PATCH_PERMISSION_MODE must match the observed OpenCode behavior');
  report('sonda PATCH permission', true, mode);
});

test('live probe §15.6: client messageID format accepted by prompt_async', { skip: LIVE_SKIP }, async (t) => {
  const ctx = liveSetup(t);
  const api = await bootServer(ctx);
  const [providerID, ...rest] = LIVE_MODEL.split('/');
  const model = { providerID, modelID: rest.join('/') };
  const permission = [{ permission: '*', pattern: '*', action: 'deny' }];
  const session = await api.createSession({ title: 'OPC: probe: messageID', permission });
  const messageID = newMessageId();
  await api.promptAsync(session.id, {
    messageID,
    model,
    parts: [{ type: 'text', text: 'Reply with the single word OK.' }],
  });
  let messages = [];
  for (let i = 0; i < 120; i += 1) {
    messages = await api.messages(session.id, { limit: 20 });
    const reply = messages.find((m) => m.info.role === 'assistant' && m.info.parentID === messageID && m.info.time?.completed);
    if (reply) break;
    await sleep(1000);
  }
  const user = messages.find((m) => m.info.id === messageID);
  const reply = messages.find((m) => m.info.role === 'assistant' && m.info.parentID === messageID);
  console.log(`LIVE-ANSWER §15.6 messageID ${messageID}: user message stored = ${Boolean(user)}; assistant parentID matches = ${Boolean(reply)}`);
  let malformedAccepted = false;
  let other = null;
  try {
    other = await api.createSession({ title: 'OPC: probe: malformed messageID', permission });
    await api.promptAsync(other.id, {
      messageID: 'msg_not-a-real-id',
      model,
      parts: [{ type: 'text', text: 'Reply OK.' }],
    });
    malformedAccepted = true;
  } catch {
    malformedAccepted = false;
  }
  if (malformedAccepted && other) await api.abort(other.id);
  console.log(`LIVE-ANSWER §15.6 malformed messageID: ${malformedAccepted ? 'accepted' : 'rejected'}`);
  assert.ok(user, 'client messageID must be kept as the user message id');
  assert.ok(reply, 'assistant parentID must reference the client messageID');
  report('sonda messageID', true, messageID);
});
