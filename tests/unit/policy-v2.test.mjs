import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionRules, checkReply, planPermissionSwitch, requiresUser } from '../../plugins/opc/scripts/lib/policy.mjs';
import { toPermissionRequest } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';
import { createRequestBridge } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { globToRegExp } from '../../plugins/opc/scripts/lib/models.mjs';

const lastMatch = (rules, action, resource) => rules.filter((rule) => (rule.action === '*' || rule.action === action)
  && globToRegExp(rule.resource).test(resource)).at(-1)?.effect;
const claude = (command, policy = {}) => requiresUser({ permission: 'shell', patterns: [command], metadata: { command } }, policy);

test('git global options and argument order do not hide destructive subcommands', () => {
  for (const command of [
    'git -C /repo reset --hard', 'git -c core.hooksPath=/dev/null push --force', 'git --no-pager reset --hard HEAD~3',
    'git push origin main --force', 'git push origin +main', 'git push origin :feature', 'git push --force-with-lease',
    'git clean -df', 'git clean -xdf', 'git branch --delete --force x', 'git --git-dir=.git reset --hard',
    'git --weird-global reset --soft',
  ]) assert.equal(claude(command), true, command);
  for (const command of ['git status', 'git -C /repo log --oneline', 'git push origin main', 'git clean -n']) {
    assert.equal(claude(command), false, command);
  }
});

test('known git global options are stripped without changing benign subcommands', () => {
  for (const option of [
    '-C /repo', '-c core.hooksPath=/dev/null', '--git-dir .git', '--git-dir=.git',
    '--work-tree /repo', '--work-tree=/repo', '--namespace test', '--namespace=test',
    '--no-pager', '-p', '--paginate', '--bare', '--no-replace-objects', '--literal-pathspecs',
    '--exec-path', '--exec-path=/tools', '-C /repo --no-pager -c core.hooksPath=/dev/null',
  ]) {
    assert.equal(claude(`git ${option} reset --hard`), true, option);
    assert.equal(claude(`git ${option} status`), false, option);
  }
  for (const command of ['git -C', 'git -c', 'git --git-dir', 'git --work-tree', 'git --namespace']) {
    assert.equal(claude(command), true, command);
  }
});

test('git destructive flags and refspecs are classified across subcommands', () => {
  for (const command of [
    'git push origin main -f', 'git push origin main --force-with-lease=main',
    'git push origin feature --delete', 'git push origin feature -d', 'git push origin --mirror', 'git push origin --prune',
    'git reset HEAD~1 --merge', 'git reset HEAD~1 --keep',
    'git clean -fd', 'git clean -x', 'git clean -d -f', 'git clean --force',
    'git branch -D feature', 'git branch feature --delete -f',
    'git tag release -d', 'git tag release --delete',
    'git checkout -- src/app.js', 'git checkout .', 'git restore -- src/app.js', 'git restore .',
    'git stash drop', 'git stash clear', 'git filter-branch --all', 'git update-ref refs/heads/feature -d',
    'sudo -u root git -C /repo reset --hard', 'bash -c "git -C /repo push origin main --force"',
  ]) assert.equal(claude(command), true, command);
  for (const command of [
    'git reset --soft HEAD~1', 'git clean --dry-run', 'git clean -d',
    'git branch --delete feature', 'git branch --force feature', 'git tag release',
    'git checkout feature', 'git restore --help', 'git stash list', 'git update-ref refs/heads/feature HEAD',
  ]) assert.equal(claude(command), false, command);
});

test('custom destructive patterns also inspect normalized git commands', () => {
  const policy = { destructiveBash: ['git push *', 'git archive *'] };
  assert.equal(claude('git -C /repo push origin main', policy), true);
  assert.equal(claude('git --no-pager archive HEAD', policy), true);
  assert.equal(claude('git -C /repo status', policy), false);
});

test('every shell resource is inspected', () => {
  assert.equal(requiresUser({ permission: 'shell', patterns: ['echo ok', 'rm -rf /x'], metadata: { command: 'echo ok' } }), true);
  assert.equal(claude('echo ok && git -C . push origin main --force'), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['echo ok', 'git -C . push origin main --force'], metadata: { command: 'echo ok' } }), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: [null, 'git -C . reset --hard'], metadata: { command: 42 } }), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: [null, 42] }), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: [null, 'echo ok'], metadata: { command: 42 } }), false);
  assert.equal(requiresUser({ permission: 'shell', patterns: [Object.create(null), 'echo ok'] }), false);
  assert.equal(requiresUser({ permission: 'shell', patterns: [], metadata: { command: 'git -C . reset --hard' } }), true);
});

test('shell reading a sensitive path, webfetch and unknown permissions need the user', () => {
  for (const command of [
    'cat .env', 'cat ".npmrc"', 'cat .aws/credentials', 'cat .kube/config',
    'echo ok && cat .netrc', 'echo $(cat .git-credentials)', 'cat .npmrc | wc -c',
    'bash -c "cat .npmrc"', 'eval "cat .netrc"',
  ]) assert.equal(claude(command), true, command);
  assert.equal(claude('cat src/app.js'), false);
  assert.equal(claude('cat private/credentials', { sensitivePaths: ['credentials'] }), true);
  assert.equal(claude('cat private/credentials', { sensitivePaths: ['private/*'] }), true);
  assert.equal(claude('cat .npmrc', { sensitivePaths: [] }), false);
  assert.equal(claude('printf --secret', { sensitivePaths: ['--secret'] }), false);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['echo ok', 'cat .npmrc'], metadata: { command: 'echo ok' } }), true);
  for (const permission of ['webfetch', 'websearch', 'something-new', 'external_directory']) {
    assert.equal(requiresUser({ permission, patterns: ['*'] }), true, permission);
  }
  for (const permission of ['read', 'glob', 'grep', 'list', 'edit', 'skill', 'question', 'todowrite', 'task']) {
    assert.equal(requiresUser({ permission, patterns: ['src/app.js'] }), false, permission);
  }
  for (const permission of ['read', 'glob', 'grep', 'list', 'edit']) {
    assert.equal(requiresUser({ permission, patterns: ['.npmrc'] }), true, permission);
  }
});

test('checkReply refuses claude approval for the bypasses', () => {
  const request = { permission: 'shell', patterns: ['git -C /w reset --hard'], metadata: { command: 'git -C /w reset --hard' } };
  assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
  assert.equal(checkReply({ approver: 'claude', request, reply: 'once', confirmedByUser: true }).ok, true);
  assert.equal(checkReply({ approver: 'claude', request, reply: 'reject' }).ok, true);
});

test('tools.deny shell beats destructive ask (write profile)', () => {
  const rules = buildPermissionRules('write', { policy: { tools: { deny: ['shell'] } } });
  assert.equal(lastMatch(rules, 'shell', 'rm -rf x'), 'deny');
  assert.equal(lastMatch(rules, 'shell', 'ls'), 'deny');
});

test('extraAllow sits before invariants', () => {
  const extraAllow = [{ action: 'subagent', resource: 'general', effect: 'allow' }];
  const rules = buildPermissionRules('write', { policy: { tools: { deny: ['subagent'] } }, extraAllow });
  assert.ok(rules.includes(extraAllow[0]));
  assert.equal(lastMatch(rules, 'subagent', 'general'), 'deny');
});

test('custom shell permissions and extra allows cannot override explicit tool denies', () => {
  const rules = buildPermissionRules('custom:test-only', {
    policy: { tools: { deny: ['shell'] } },
    permissionProfiles: { 'test-only': [{ action: 'shell', resource: 'npm test', effect: 'allow' }] },
    extraAllow: [{ action: 'shell', resource: '*', effect: 'allow' }],
  });
  assert.equal(lastMatch(rules, 'shell', 'rm -rf x'), 'deny');
  assert.equal(lastMatch(rules, 'shell', 'npm test'), 'deny');
});

test('extra allows preserve sensitive paths, denied agents and the browser invariant', () => {
  const rules = buildPermissionRules('read-only', {
    deniedAgentGlobs: ['work-*'],
    extraAllow: ['external_directory', 'grep', 'read', 'glob', 'subagent', 'browser'].map((action) => ({ action, resource: '*', effect: 'allow' })),
  });
  assert.equal(lastMatch(rules, 'external_directory', '/outside'), 'deny');
  assert.equal(lastMatch(rules, 'grep', 'notes.txt'), 'deny');
  for (const action of ['read', 'grep', 'glob']) assert.equal(lastMatch(rules, action, '.env'), 'deny');
  assert.equal(lastMatch(rules, 'subagent', 'work-reviewer'), 'deny');
  assert.equal(lastMatch(rules, 'browser', '*'), 'deny');
});

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
