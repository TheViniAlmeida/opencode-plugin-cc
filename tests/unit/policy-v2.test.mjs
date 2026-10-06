import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionRules, planPermissionSwitch, requiresUser } from '../../plugins/opc/scripts/lib/policy.mjs';
import { toPermissionRequest } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';
import { createRequestBridge } from '../../plugins/opc/scripts/commands/task-worker.mjs';

test('read-only V2 rules and ordering', () => {
  const rules = buildPermissionRules('read-only', { policy: {} });
  assert.deepEqual(rules.slice(0, 5), [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'question', resource: '*', effect: 'allow' },
  ]);
  assert.ok(rules.some((x) => x.action === 'external_directory' && x.effect === 'deny'));
  assert.ok(rules.some((x) => x.action === 'browser' && x.effect === 'deny'));
  assert.ok(!rules.some((x) => ['bash', 'task', 'list', 'lsp', 'todowrite', 'doom_loop'].includes(x.action)));
});

test('write V2 rules ask for destructive shell', () => {
  const rules = buildPermissionRules('write', { policy: {} });
  assert.ok(rules.some((x) => x.action === 'shell' && x.resource === 'rm *' && x.effect === 'ask'));
});

test('requiresUser consumes a recorded V2 shell request', () => {
  const req = toPermissionRequest(loadContractSample('permission-request.json'));
  assert.equal(requiresUser({ ...req, metadata: { command: 'rm -rf /' } }, {}), true);
  assert.equal(requiresUser(req, {}), false);
});

test('profile switch replaces all rules', () => {
  const a = buildPermissionRules('read-only', { policy: {} });
  const b = buildPermissionRules('write', { policy: {} });
  assert.deepEqual(planPermissionSwitch(a, a), { kind: 'none' });
  assert.deepEqual(planPermissionSwitch(a, b), { kind: 'replace', rules: b });
});

test('read-only bridge forwards questions and rejects permission with session ID', async () => {
  let job = { pendingRequest: [], status: 'running' };
  const calls = [];
  const bridge = createRequestBridge({ jobId: 'job', stateDir: '/tmp', profileKind: 'read-only',
    update: async (patch) => { job = { ...job, ...patch(job) }; },
    api: { replyPermission: async (...args) => calls.push(args), rejectQuestion: async (...args) => calls.push(args) },
  });
  try {
    await bridge.onPermission({ id: 'per_one', sessionID: 'ses_one', permission: 'shell', patterns: ['ls'] });
    assert.deepEqual(calls[0].slice(0, 2), ['ses_one', 'per_one']);
    await bridge.onQuestion({ id: 'frm_one', sessionID: 'ses_one', questions: [{ key: 'q0' }] });
    assert.deepEqual(job.pendingRequest.map((request) => request.id), ['frm_one']);
  } finally { bridge.dispose(); }
});
