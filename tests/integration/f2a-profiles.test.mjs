import test from 'node:test';
import assert from 'node:assert/strict';
import { F2A_POLICY, opc, readFakeState, requestsTo, setupF2a } from '../helpers.mjs';
import { NPM_TEST_ONLY_RULES, READ_ONLY_RULES, WRITE_RULES } from '../fixtures/expected-rules-f2a.mjs';

test('profile rules are sent to POST /api/session in V2 form (read-only, write, custom)', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok', config: { permissionProfiles: { 'npm-test-only': [{ action: 'shell', resource: 'npm test', effect: 'allow' }] } } });
  for (const [index, [args, expected]] of [
    [['task', 'read only please'], READ_ONLY_RULES],
    [['task', '--write', 'write please'], WRITE_RULES],
    [['task', '--profile', 'npm-test-only', 'tests only'], NPM_TEST_ONLY_RULES],
  ].entries()) {
    const r = await opc(ctx, args);
    assert.equal(r.code, 0, r.stderr);
    const posts = requestsTo(ctx.env, 'POST', '/api/session');
    assert.equal(posts.length, index + 1, args.join(' '));
    const state = readFakeState(ctx.env);
    const session = Object.values(state.sessions).find((entry) => entry.title === `OPC: task: ${args.at(-1)}`);
    assert.ok(session, args.join(' '));
    assert.deepEqual(session.permissions, expected, args.join(' '));
  }
});

test('unknown custom profile and --write with --profile are usage errors', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok' });
  assert.equal((await opc(ctx, ['task', '--profile', 'ghost', 'x'])).code, 2);
  assert.equal((await opc(ctx, ['task', '--write', '--profile', 'ghost', 'x'])).code, 2);
  assert.equal(F2A_POLICY.approver, 'user');
});

test('task checks implicit build before creating a session and permits an explicit allowed agent', async (t) => {
  const ctx = setupF2a(t, { scenario: 'ok', config: { policy: { ...F2A_POLICY, agents: { deny: ['build'] } } } });
  const denied = await opc(ctx, ['task', '--json', 'test']);
  assert.equal(denied.code, 4, denied.stdout + denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, 'POLICY_DENIED');
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').length, 0);
  assert.ok(requestsTo(ctx.env, 'GET', '/api/agent').length > 0);
  const allowed = await opc(ctx, ['task', '--agent', 'plan', '--json', 'test']);
  assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
  assert.equal(requestsTo(ctx.env, 'POST', '/api/session').at(-1).body.agent, 'plan');
});
