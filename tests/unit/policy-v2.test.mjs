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
    '-C /repo', '-c core.quotePath=false', '--git-dir .git', '--git-dir=.git',
    '--work-tree /repo', '--work-tree=/repo', '--namespace test', '--namespace=test',
    '--no-pager', '-p', '--paginate', '--bare', '--no-replace-objects', '--literal-pathspecs',
    '--exec-path', '--exec-path=/tools', '-C /repo --no-pager -c core.quotePath=false',
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
    'git branch -D feature', 'git branch feature --delete -f', 'git branch --force feature',
    'git tag release -d', 'git tag release --delete',
    'git checkout -- src/app.js', 'git checkout .', 'git restore -- src/app.js', 'git restore .',
    'git stash drop', 'git stash clear', 'git filter-branch --all', 'git update-ref refs/heads/feature -d',
    'sudo -u root git -C /repo reset --hard', 'bash -c "git -C /repo push origin main --force"',
  ]) assert.equal(claude(command), true, command);
  for (const command of [
    'git reset --soft HEAD~1', 'git clean --dry-run', 'git clean -d',
    'git branch --delete feature', 'git tag release',
    'git checkout feature', 'git restore --help', 'git stash list', 'git update-ref refs/heads/feature HEAD',
  ]) assert.equal(claude(command), false, command);
});

test('custom destructive patterns also inspect normalized git commands', () => {
  const policy = { destructiveBash: ['git push *', 'git archive *'] };
  assert.equal(claude('git -C /repo push origin main', policy), true);
  assert.equal(claude('git --no-pager archive HEAD', policy), true);
  assert.equal(claude('git -C /repo status', policy), false);
});

const fix1Cases = [
  ['grouped short flags and long option prefixes', true, [
    'git push -uf origin main', 'git push origin main -fu', 'git push origin x -df', 'git push -fd origin x',
    'git push --del origin x', 'git push origin --mirr', 'git push origin main --force-w',
    'git push origin main --force-w=main', 'git push origin main --forc', 'git push origin --pru',
    'git reset --har HEAD', 'git reset --har', 'git reset --mer HEAD', 'git reset --kee HEAD',
    'git clean -fdx', 'git clean -df', 'git clean -fd', 'git clean --forc', 'git clean -f -- -n',
    'git branch --del --forc x', 'git tag --del x', 'git tag -df x',
    'git checkout --forc', 'git switch --discard', 'git restore --work src/a',
    'git stash drop --quiet',
  ]],
  ['clean dry runs', false, [
    'git clean -fn', 'git clean -nf', 'git clean -fdxn', 'git clean -df -n',
    'git clean --force --dry-run', 'git clean -x --dry-r', 'git -C /repo clean -fn',
  ]],
  ['git configuration fails closed outside the allowlist', true, [
    "git -c alias.x='reset --hard' x", "git -c alias.x='!rm -rf .' x",
    "git -c core.pager='rm -rf x' log", "git -c core.sshCommand='sh synthetic-helper' push origin main",
    'git -c CoRe.HoOkSpAtH=/synthetic/hooks status', 'git -calias.x=status x',
    'git --config-env=alias.x=SYNTHETIC_VALUE x', 'git --config-env core.pager=SYNTHETIC_VALUE log',
    'git --config-env=CORE.SSHCOMMAND=SYNTHETIC_VALUE push origin main',
    'git -c unknown.setting=value status', 'git --config-env=unknown.setting=SYNTHETIC_VALUE status',
    'git --config-env', 'git --config-env=core.pager',
    ...[
      'core.editor', 'core.fsmonitor', 'core.gitproxy', 'credential.helper', 'credential.synthetic',
      'protocol.file.allow', 'url.synthetic.insteadof', 'include.path', 'includeif.synthetic.path',
      'pager.log', 'sequence.editor', 'diff.external', 'diff.synthetic.textconv', 'filter.synthetic.clean',
      'gpg.program', 'uploadpack.packobjectsHook', 'receivepack.synthetic',
    ].map((key) => `git -c ${key}=synthetic status`),
  ]],
  ['git configuration allowlist', false, [
    'git -c color.ui=always status', 'git -c user.name=Synthetic status',
    'git -c user.email=synthetic@example.invalid log', 'git -c core.quotePath=false status',
    'git -c advice.detachedHead=false status', 'git -c init.defaultBranch=main status',
    'git -c CORE.QUOTEPATH=false status', 'git -ccolor.ui=always status',
    'git --config-env=color.ui=SYNTHETIC_VALUE status', 'git --config-env core.quotePath=SYNTHETIC_VALUE status',
  ]],
  ['branch deletion and forced ref movement', true, [
    'git branch -d -f x', 'git branch -df x', 'git branch -fd x', 'git branch -vD x',
    'git branch -f main HEAD~5', 'git branch --force main HEAD~5', 'git branch --forc main HEAD~5',
  ]],
  ['dynamic arguments to destructive git subcommands', true, [
    'F=--force; git push origin main $F', 'git push origin $(echo --force)', 'git push origin main --f*',
    ...['push', 'reset', 'clean', 'branch', 'tag', 'checkout', 'switch', 'restore', 'stash', 'update-ref', 'rm']
      .map((subcommand) => `git ${subcommand} "$SYNTHETIC_ARG"`),
  ]],
  ['additional destructive git commands', true, [
    'git checkout -f', 'git checkout --force', 'git switch -f', 'git switch --force',
    'git switch --discard-changes', 'git switch -Cf main',
    'git restore --worktree src/a', 'git restore src/a', 'git restore -W src/a',
    'git restore --staged --worktree src/a', 'git restore -SW src/a',
    'git update-ref --delete HEAD', 'git update-ref -d HEAD',
    'git rm -rf .', 'git rm --force src/a', 'git rm -r .',
    'git reflog expire --expire=now --all', 'git reflog delete HEAD@{1}',
    'git gc --prune=now', 'git gc --prune=all',
    'git worktree remove -f /synthetic/tree', 'git worktree remove --force /synthetic/tree',
    'git submodule deinit -f', 'git submodule deinit --force synthetic', 'git tag -f',
  ]],
  ['benign git option and staging forms', false, [
    'git --no-optional-locks status', 'git --version', 'git --help', 'git -P status',
    'git --no-lazy-fetch status', 'git --no-advice status',
    'git restore --staged .', 'git restore -S .', 'git restore --stag src/a', 'git restore --help',
    'git restore --source=HEAD --staged src/a',
    'git rm src/a', 'git rm -r src', 'git gc --prune=never', 'git reflog show',
    'git worktree remove /synthetic/tree', 'git submodule deinit synthetic',
    'git commit -m "$MSG"', 'git log $(printf HEAD)',
  ]],
  ['sensitive values in options and shell globs', true, [
    'cat --file=.env', 'cat --file=synthetic=.env', 'ssh -i~/.ssh/id_rsa host',
    'cat -f.env', 'cat .e*', 'cat .en?', 'cat .e[n]v', 'cat synthetic/.e*',
    'cat --file=.e[n]v', 'cat id_r??', 'cat id_ed*', 'cat .npmr?', 'cat .netr?',
    'cat .git-cred*', 'cat secrets.e*', 'cat credentia*', 'cat *.pem', 'cat *.key',
  ]],
  ['benign glob and option paths', false, [
    'cat --file=README.md', 'cat src/*.mjs', 'cat .e[x]v', 'cat .e[!n]v', 'cat .e[^n]v',
    'cat src/app?.js', 'cat README.[mt][dx]',
  ]],
  ['wrapper commands', true, [
    'timeout 5 git reset --hard', 'timeout -s TERM -k 2 --preserve-status --foreground -v 5 git reset --hard',
    'timeout --signal=TERM --kill-after=2 5 git reset --hard', 'timeout -- 5 git reset --hard',
    'setsid -f -w -c git reset --hard', 'stdbuf -i 0 -oL -e 0 git reset --hard',
    'ionice -c 3 -n7 -p 123 -t git reset --hard',
    'flock -x -w 5 /synthetic/lock git reset --hard', 'flock /synthetic/lock -c "git reset --hard"',
    'flock -c "git reset --hard" /synthetic/lock', 'flock --command="git reset --hard" /synthetic/lock',
    'watch "echo ok && git reset --hard"', 'watch -n 2 git reset --hard',
    'busybox timeout 5 git reset --hard', 'busybox sh -c "git reset --hard"',
    'timeout', 'timeout 5', 'timeout "$DURATION" git status', 'flock /synthetic/lock -c "$SCRIPT"',
    'watch "$SCRIPT"', 'stdbuf --unknown-option git status', 'busybox',
  ]],
  ['benign wrapper commands', false, [
    'timeout 5 git status', 'timeout -s TERM -k 1s 5s git status', 'setsid -f git status',
    'stdbuf --output=L git status', 'ionice --class=3 --classdata=7 git status',
    'flock -s /synthetic/lock git status', 'flock /synthetic/lock -c "git status"',
    'flock --command="git status" /synthetic/lock', 'watch -n 2 "git status"',
    'watch "echo safe; git status"', 'busybox cat README.md',
  ]],
  ['previously verified benign commands', false, [
    'git status', 'git log', 'git diff', 'git show', 'git -C /repo status', 'git add', 'git commit',
    'git push', 'git push origin main', 'git push -u origin feature', 'git pull --rebase',
    'git fetch --all --prune', 'git branch -d feature', 'git checkout main', 'git stash',
    'git rebase', 'git merge', 'ls', 'ls -la', 'cat README.md', 'grep -rn foo src', 'npm test', 'echo hi',
  ]],
  ['previously verified destructive bypasses', true, [
    '/usr/bin/git push --force', 'sudo git push --force', 'sudo -u root git -C x reset --hard',
    'command git reset --hard', 'env git reset --hard', 'GIT_DIR=x git reset --hard',
    '"git" push --force', 'g""it push --force', 'git -C=x reset --hard', 'git -C x -C y reset --hard',
    'git --git-dir=x --work-tree=y reset --hard', 'git -p reset --hard',
    'git push --force origin main', 'git push origin refs/heads/x:refs/heads/x --force',
    'git push origin +HEAD:main', 'git push origin HEAD:refs/heads/x --delete', 'xargs git', 'nohup git reset --hard',
  ]],
];
for (const [group, expected, commands] of fix1Cases) {
  for (const command of commands) {
    test(`F11 fix1: ${group}: ${command}`, () => {
      assert.equal(claude(command), expected, command);
      if (expected) {
        const request = { permission: 'shell', patterns: [command], metadata: { command } };
        assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
      }
    });
  }
}

test('clean dry runs still honor custom destructive policy', () => {
  assert.equal(claude('git -C /repo clean -fn', { destructiveBash: ['git clean *'] }), true);
});

test('sensitive shell glob detection respects configured paths', () => {
  assert.equal(claude('cat .e*', { sensitivePaths: [] }), false);
  assert.equal(claude('cat custom.?ey', { sensitivePaths: ['custom.key'] }), true);
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
