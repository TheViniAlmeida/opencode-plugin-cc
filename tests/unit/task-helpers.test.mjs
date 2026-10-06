import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptText, exitCodeForJob, normalizeResumeFlag, projectContextBlock, resolveProfile, sessionTitle, summarize, catalogFromV2, rulesFromV2 } from '../../plugins/opc/scripts/commands/task.mjs';

test('task adapts V2 model catalog and permission rules without retaining provider settings', () => {
  const catalog = catalogFromV2([{ id: 'p', activation: 'enabled', settings: { apiKey: 'must-not-retain' } }], [{ id: 'm', modelID: 'm', providerID: 'p', variants: [{ id: 'high' }], settings: { apiKey: 'must-not-retain' } }]);
  assert.equal(catalog.byFull.get('p/m').modelID, 'm');
  assert.deepEqual(catalog.byFull.get('p/m').variants, ['high']);
  assert.equal(JSON.stringify(catalog).includes('must-not-retain'), false);
  assert.deepEqual(rulesFromV2([{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: 'npm test', action: 'ask' }, { permission: 'doom_loop', pattern: '*', action: 'deny' }]), [{ action: '*', resource: '*', effect: 'deny' }, { action: 'shell', resource: 'npm test', effect: 'ask' }]);
});

test('normalizeResumeFlag: id only when it looks like a job or session id', () => {
  assert.deepEqual(normalizeResumeFlag(['--resume', 'task-abc123-x1y2z3', 'more']), ['--resume-id', 'task-abc123-x1y2z3', 'more']);
  assert.deepEqual(normalizeResumeFlag(['--resume', 'ses_01ABC']), ['--resume-id', 'ses_01ABC']);
  assert.deepEqual(normalizeResumeFlag(['--resume', 'fix', 'this']), ['--resume-last', 'fix', 'this']);
  assert.deepEqual(normalizeResumeFlag(['--resume=task-abc123-x1y2z3']), ['--resume-id', 'task-abc123-x1y2z3']);
  assert.deepEqual(normalizeResumeFlag(['--json', '--', '--resume', 'x']), ['--json', '--', '--resume', 'x']);
});

test('buildPromptText: project context first, template with literal $ sequences', () => {
  const project = { goal: 'Ship opc', scope: ['plugins/'], taskTypes: ['ask'] };
  assert.equal(projectContextBlock(project), '<project_context>\ngoal: Ship opc\nscope: plugins/\ntask types: ask\n</project_context>');
  assert.equal(projectContextBlock({}), '');
  assert.equal(buildPromptText({ userPrompt: 'a $& b $1', template: 'Q:\n{{USER_REQUEST}}\n' }), 'Q:\na $& b $1\n');
  assert.equal(buildPromptText({ userPrompt: 'x', project }), `${projectContextBlock(project)}\n\nx`);
});

test('summarize and sessionTitle', () => {
  assert.equal(summarize('  fix\n the   bug  '), 'fix the bug');
  assert.equal(summarize('x'.repeat(80)).length, 56);
  assert.equal(sessionTitle('task', 'fix the bug'), 'OPC: task: fix the bug');
});

test('resolveProfile', () => {
  assert.equal(resolveProfile({}, { readOnly: false }), 'read-only');
  assert.equal(resolveProfile({ write: true }, { readOnly: false }), 'write');
  assert.equal(resolveProfile({ profile: 'npm-test-only' }, { readOnly: false }), 'custom:npm-test-only');
  assert.equal(resolveProfile({ profile: 'custom:x' }, { readOnly: false }), 'custom:x');
  assert.throws(() => resolveProfile({ write: true, profile: 'x' }, { readOnly: false }), (e) => e.code === 'CONFLICT');
  assert.throws(() => resolveProfile({ write: true, profile: 'write' }, { readOnly: false }), (e) => e.code === 'CONFLICT');
  assert.throws(() => resolveProfile({ write: true }, { readOnly: true }), (e) => e.code === 'READ_ONLY_KIND');
  assert.equal(resolveProfile({}, { readOnly: true }), 'read-only');
});

test('exitCodeForJob maps job status to spec §4.1', () => {
  assert.equal(exitCodeForJob({ status: 'completed' }), 0);
  assert.equal(exitCodeForJob({ status: 'waiting_permission' }), 3);
  assert.equal(exitCodeForJob({ status: 'failed' }), 7);
  assert.equal(exitCodeForJob({ status: 'cancelled' }), 130);
});
