import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptText, exitCodeForJob, normalizeResumeFlag, projectContextBlock, resolveProfile, sessionTitle, summarize, resolveTaskCandidates } from '../../plugins/opc/scripts/commands/task.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';

test('task uses the model declared in the OpenCode config when no opc model is configured', async () => {
  const calls = [];
  const api = {
    providers: async () => [{ id: 'p', activation: 'enabled' }, { id: 'opencode', activation: 'enabled' }],
    models: async () => [{ id: 'm', modelID: 'm', providerID: 'p', variants: [] }, { id: 'free', modelID: 'free', providerID: 'opencode', variants: [] }],
    defaultModel: async () => { calls.push('defaultModel'); return { providerID: 'opencode', id: 'free' }; },
    getConfigSources: async () => { calls.push('config'); return [{ type: 'document', info: { model: 'p/m' } }]; },
  };
  const { resolution } = await resolveTaskCandidates({ api, kind: 'task', flags: {}, config: { policy: {} } });
  assert.deepEqual(resolution.candidates.map(({ full, source }) => ({ full, source })), [{ full: 'p/m', source: 'opencode' }]);
  assert.deepEqual(calls.sort(), ['config', 'defaultModel']);
});

test('task never runs on the server default model when the OpenCode config declares none', async () => {
  const api = {
    providers: async () => [{ id: 'opencode', activation: 'enabled' }],
    models: async () => [{ id: 'free', modelID: 'free', providerID: 'opencode', variants: [] }],
    defaultModel: async () => ({ providerID: 'opencode', id: 'free' }),
    getConfigSources: async () => [{ type: 'directory', path: '<workspace>' }, { type: 'document', info: { share: 'disabled' } }],
  };
  await assert.rejects(resolveTaskCandidates({ api, kind: 'task', flags: {}, config: { policy: {} } }), (e) => e.code === 'NO_MODEL' && e.exitCode === 2);
});

test('task keeps an explicit opc model ahead of the OpenCode default', async () => {
  const api = {
    providers: async () => [{ id: 'p', activation: 'enabled' }],
    models: async () => [{ id: 'm', modelID: 'm', providerID: 'p', variants: [] }],
    defaultModel: async () => ({ providerID: 'p', id: 'm' }),
    getConfigSources: async () => [{ type: 'document', info: { model: 'p/m' } }],
  };
  const { resolution } = await resolveTaskCandidates({ api, kind: 'task', flags: {}, config: { defaultModel: 'p/m', policy: {} } });
  assert.equal(resolution.candidates[0].source, 'default');
});

test('task adapts V2 model catalog and permission rules without retaining provider settings', () => {
  const catalog = buildCatalog({ providers: [{ id: 'p', activation: 'enabled', settings: { apiKey: 'must-not-retain' } }], models: [{ id: 'm', modelID: 'm', providerID: 'p', variants: [{ id: 'high' }], settings: { apiKey: 'must-not-retain' } }] });
  assert.equal(catalog.byFull.get('p/m').modelID, 'm');
  assert.deepEqual(catalog.byFull.get('p/m').variants, ['high']);
  assert.equal(JSON.stringify(catalog).includes('must-not-retain'), false);
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
