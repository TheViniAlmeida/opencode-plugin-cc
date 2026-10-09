import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildPermissionRules, checkReply, planPermissionSwitch, requiresUser } from '../../plugins/opc/scripts/lib/policy.mjs';
import { toPermissionRequest } from '../../plugins/opc/scripts/lib/opencode-v2.mjs';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';
import { createRequestBridge } from '../../plugins/opc/scripts/commands/task-worker.mjs';
import { globToRegExp } from '../../plugins/opc/scripts/lib/models.mjs';

const lastMatch = (rules, action, resource) => rules.filter((rule) => (rule.action === '*' || rule.action === action)
  && globToRegExp(rule.resource).test(resource)).at(-1)?.effect;
const claude = (command, policy = {}) => requiresUser({ permission: 'shell', patterns: [command], metadata: { command } }, policy);

const fix4Cases = [
  ['set and shopt fail closed outside their literal allowlists with git', true, [
    'F=-a; set $F; GIT_SSH_COMMAND=x git ls-remote h:x',
    ...['$F', '"$F"', '${F}', '$F $G', '-e $F', '+e $F', '-- $F', '-o "$OPTION"',
      '-a', '+a', '-o allexport', '+o allexport', '-o', '-k', '-euaf', '-o vi',
      '+o errexit', '-e literal'].map((options) => `set ${options}; git status`),
    'command set "$F"; git status', 'builtin set -o allexport; git status',
    'command -p -- set -a; git status', 'command -p -- shopt -so allexport; git status',
    'shopt -so allexport; GIT_SSH_COMMAND=x git ls-remote h:x',
    ...['-so allexport', '-o -s allexport', '-s allexport', '-s "$OPTION"',
      '-s $OPTION', '-s expand_aliases', '-s extdebug', '-p', '-s globstar $OPTION']
      .map((options) => `shopt ${options}; git status`),
    'command shopt -so allexport; git status', 'builtin shopt -s "$OPTION"; git status',
    'sh -c \'set "$F"; git status\'',
    'set -a; env git status', 'set "$F"; nice git status',
    'set -a; timeout 5 sh -c \'git status\'',
    'env sh -c \'set "$F"; git status\'',
  ]],
  ['shell startup options fail closed with git through every shell and wrappers', true, [
    ...['bash', 'sh', 'dash', 'zsh', 'ksh', 'busybox sh', 'env bash', 'nice sh', 'timeout 5 ksh']
      .flatMap((shell) => ['-ac', '-ca', '-a -c', '+a -c', '-o allexport -c', '-i -c',
        '--rcfile synthetic -c', '--init-file synthetic -c', '-c -a', '-c -i', '-c -o allexport']
        .map((options) => `${shell} ${options} 'git status'`)),
    'bash -ac \'GIT_SSH_COMMAND=x git ls-remote h:x\'',
    'sh -ac \'GIT_SSH_COMMAND=x git ls-remote h:x\'',
    'bash -ac \'GIT_SSH_COMMAND=x; git ls-remote h:x\'',
    'sh -ac \'GIT_SSH_COMMAND=x; git ls-remote h:x\'',
    'bash -o "$OPTION" -c \'git status\'', 'bash "$OPTIONS" -c \'git status\'',
    'bash -c "$SCRIPT"', 'ksh -c "$SCRIPT"', 'busybox sh -c "$SCRIPT"',
    'bash --rcfile synthetic -c \'rm -rf synthetic\'',
  ]],
  ['git output options require the user across subcommands', true, [
    ...['show', 'format-patch', 'stash show', 'whatchanged', 'diff-tree', 'range-diff',
      'reflog', 'shortlog', 'blame', 'status', 'archive', 'log', 'diff']
      .flatMap((command) => [`git ${command} --output=victim HEAD`, `git ${command} --output victim`]),
    'git format-patch --output=x', 'git -C /synthetic show --output=victim HEAD',
    'env git show --output=victim HEAD', 'sh -c \'git show --output=victim HEAD\'',
  ]],
  ['literal shell option allowlists preserve benign commands', false, [
    ...['-e', '-u', '-x', '-f', '+e', '+u', '+x', '+f', '-eu', '-eux', '-euxf', '+euxf',
      '-o pipefail', '+o pipefail', '-o errexit', '-o nounset', '-o xtrace', '-o noglob',
      '-euo pipefail', '-euxfo pipefail', '-e -u -o pipefail', '-- a b', '-- -a']
      .map((options) => `set ${options}; git status`),
    'set -euo pipefail; git log', 'set -x; git diff',
    ...['nullglob', 'globstar', 'extglob', 'dotglob', 'failglob', 'nocaseglob']
      .flatMap((name) => [`shopt -s ${name}; git status`, `shopt -u ${name}; git log`]),
    'shopt -s globstar nullglob; git diff',
    'command set -e; git status', 'builtin shopt -s globstar; git status',
    'command -p -- set -e; git status', 'command -p -- shopt -s globstar; git status',
    ...['bash', 'sh', 'dash', 'zsh', 'ksh', 'busybox sh', 'env bash', 'nice sh', 'timeout 5 ksh']
      .flatMap((shell) => ['-c', '-ec', '-euxlc', '-e -u -c', '-o pipefail -c', '-euo pipefail -c',
        '-c -e', '-c --', '-eco pipefail', '-oc pipefail', '-c -o pipefail']
        .map((options) => `${shell} ${options} 'git log'`)),
    'bash -c \'git status\'', 'bash -ec \'git log\'', 'sh -c \'npm test\'',
    'set -a; npm test', 'set $F; npm test', 'shopt -so allexport; npm test',
    'set +a', 'set -o allexport',
    'bash -ac \'npm test\'', 'bash -i -c \'npm test\'',
    'bash --rcfile synthetic -c \'npm test\'',
    'git show -- --output=victim', 'git log --grep --output=victim',
    'git push --push-option --output=victim origin main',
  ]],
  ['benign probes from rereview3 remain free', false, [
    'git status', 'git log', 'git diff', 'git show', 'git add', 'git commit', 'git push',
    'git push origin main', 'git pull --rebase', 'git fetch', 'git fetch --all --prune',
    'ls', 'ls -la', 'cat README.md', 'npm test', 'echo hi', 'export FOO=bar; git status',
    'NODE_ENV=test npm test', 'set -e; git status', 'set -x; ls', 'set -euo pipefail; git status',
    'cat ~/.config/app/$X', 'ls ./src/$X', 'PATH_SUFFIX=x npm test', 'local x=1',
    'git commit -m "$MSG"', 'git log --oneline -5', 'LDFLAGS=-x make', 'ENVIRONMENT=x npm test',
    'cat src/$X', 'set -- a b; git status', 'readonly FOO=1', 'git -C /repo status',
    'git branch -d feature', 'git checkout main', 'git stash', 'git rebase', 'git merge',
    'grep -rn foo src', 'GIT_TERMINAL_PROMPT=0 git status', 'GIT_TRACE=1 git status',
    'export PATH; git status', 'git --exec-path',
  ]],
];
for (const [group, expected, commands] of fix4Cases) {
  for (const command of commands) {
    test(`F11 fix4: ${group}: ${command}`, () => {
      assert.equal(claude(command), expected, command);
      if (expected) {
        assert.equal(checkReply({ approver: 'claude', request: { permission: 'shell', patterns: [command] }, reply: 'once' }).code, 'NEEDS_USER');
      }
    });
  }
}

test('F11 fix4: unsafe shell options still honor custom destructive commands', () => {
  const policy = { destructiveBash: ['deploy *'] };
  for (const command of ['set "$F"; deploy synthetic', 'shopt -so allexport; deploy synthetic',
    'bash -ac \'deploy synthetic\'', 'ksh --rcfile synthetic -c \'deploy synthetic\'']) {
    assert.equal(claude(command, policy), true, command);
  }
});

const fix3Cases = [
  ['allexport cannot hide git environment assignments', true, [
    ...['-a', '-ae', '-ka', '-aeu', '-o allexport', '-e -o allexport'].map((options) =>
      `set ${options}; GIT_SSH_COMMAND=synthetic; git ls-remote h:x`),
    'set -a; git status', 'set -o allexport; FOO=bar; git log',
    'set -a && GIT_PAGER=synthetic && git log', 'set -a\nGIT_PAGER=synthetic\ngit log',
    'set -a; sh -c "GIT_PAGER=synthetic; git log"',
    'sh -c "set -a; GIT_SSH_COMMAND=synthetic; git ls-remote h:x"',
    'command set -a; GIT_SSH_COMMAND=synthetic; git ls-remote h:x',
    'builtin set -o allexport; GIT_SSH_COMMAND=synthetic; git ls-remote h:x',
    'set -a; rm -rf synthetic', 'set -o allexport; docker volume rm synthetic',
  ]],
  ['declarations with dynamic names require the user', true, [
    ...['export', 'declare', 'typeset', 'readonly', 'local'].flatMap((command) => [
      `${command} "$N=synthetic"`, `${command} $N=synthetic`, `${command} \${N}=x`,
      `${command} PREFIX_\${N}=synthetic`, `${command} "$N"`,
    ]),
    'N=GIT_SSH_COMMAND; export "$N=synthetic"; git ls-remote h:x',
    'N=GIT_SSH_COMMAND; export $N=synthetic; git ls-remote h:x',
    'N=GIT_SSH_COMMAND; export ${N}=synthetic; git ls-remote h:x',
    'export -- $N=synthetic', 'declare -x $N=synthetic', 'declare -gx "$N=synthetic"',
    'typeset -x ${N}=synthetic', 'command export "$N=synthetic"',
  ]],
  ['execution environment assignments require the user', true, [
    ...['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_SYNTHETIC', 'BASH_ENV', 'ENV', 'PATH',
      'PROMPT_COMMAND', 'PS4', 'SHELLOPTS', 'BASHOPTS'].flatMap((name) => [
      `${name}=synthetic git log`, `${name}=synthetic ls`, `env ${name}=synthetic ls`,
      `export ${name}=synthetic; ls`, `declare -x ${name}=synthetic; ls`,
      `typeset -x ${name}=synthetic; ls`, `readonly ${name}=synthetic; ls`, `local ${name}=synthetic`,
    ]),
    'LD_PRELOAD=synthetic.so git log', 'PATH=/synthetic:$PATH git log', 'BASH_ENV=/synthetic/startup ls',
    'env -i LD_AUDIT=synthetic ls', 'timeout 5 env ENV=synthetic ls',
    'sh -c "export BASH_ENV=synthetic; ls"',
  ]],
  ['git output and exec path overrides require the user', true, [
    'git log --output=synthetic', 'git log --output synthetic', 'git --no-pager log --output=synthetic',
    'git log --oneline -5 --output=synthetic', 'git diff --output=synthetic',
    'git --exec-path=/synthetic status', 'git --exec-path=/synthetic x',
    'git -C /synthetic --exec-path=/synthetic log',
  ]],
  ['dynamic paths inside sensitive directories require the user', true, [
    'cat ~/.aws/$X', 'cat ./.aws/$X', 'cat /home/u/.aws/$X', 'cat ~/.kube/$X',
    'cat ~/.kube/conf$X', 'cat /home/u/kubec$X', 'cat ~/.aws/"$X"',
    'cat ./.kube/${X}', 'cat /home/u/./.aws//$X',
  ]],
  ['required benign commands stay free', false, [
    'git status', 'git log', 'git log --oneline -5', 'git commit -m "$MSG"',
    'export FOO=bar; git status', 'export PATH; git status', 'PATH_SUFFIX=x npm test', 'set -e; git status',
    'set -euo pipefail; git status', 'set -x; ls', 'cat ~/.config/app/$X', 'ls ./src/$X',
    'NODE_ENV=test npm test', 'local x=1', 'export FOO="$VALUE"; git status',
    'declare -x FOO="$VALUE"; git status', 'typeset -x FOO="$VALUE"; ls',
    'readonly FOO="$VALUE"; ls', 'local FOO="$VALUE"', 'set -- -a; git status',
    'set -a; ls', 'git --exec-path', 'git log --grep --output=synthetic',
  ]],
];
for (const [group, expected, commands] of fix3Cases) {
  for (const command of commands) {
    test(`F11 fix3: ${group}: ${command}`, () => {
      assert.equal(claude(command), expected, command);
      if (expected) {
        assert.equal(checkReply({ approver: 'claude', request: { permission: 'shell', patterns: [command] }, reply: 'once' }).code, 'NEEDS_USER');
      }
    });
  }
}

test('F11 fix3: dynamic directory checks respect configured sensitive paths', () => {
  assert.equal(claude('cat ~/.aws/$X', { sensitivePaths: [] }), false);
  assert.equal(claude('cat ~/.kube/$X', { sensitivePaths: ['**/.aws/credentials'] }), false);
  assert.equal(claude('cat /home/u/.vault/$X', { sensitivePaths: ['**/.vault/credentials'] }), true);
  assert.equal(claude('cat ./.private/$X', { sensitivePaths: ['.private/credentials'] }), true);
  assert.equal(claude('cat /home/u/.vault/$X', { sensitivePaths: ['**/.other/credentials'] }), false);
  assert.equal(claude('cat .vaultX$X', { sensitivePaths: ['**/.vault/credentials'] }), false);
});

test('F11 fix3: ten thousand shell words finish within 250 ms per command', () => {
  const script = `
    import { requiresUser } from ${JSON.stringify(new URL('../../plugins/opc/scripts/lib/policy.mjs', import.meta.url).href)};
    const check = (command) => requiresUser({ permission: 'shell', patterns: [command] });
    check('cat a'); check('git status');
    const results = ['cat ', 'git status '].map((prefix) => {
      const command = prefix + 'a '.repeat(10000);
      const start = performance.now();
      const required = check(command);
      return { required, elapsed: performance.now() - start };
    });
    console.log(JSON.stringify(results));
  `;
  const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 }));
  for (const { required, elapsed } of results) {
    assert.equal(required, false);
    assert.ok(elapsed < 250, `${elapsed} ms`);
  }
});

test('F11 fix2: shell globs with repeated or separated stars finish within 50 ms', () => {
  const script = `
    import { requiresUser } from ${JSON.stringify(new URL('../../plugins/opc/scripts/lib/policy.mjs', import.meta.url).href)};
    const check = (command, policy) => requiresUser({ permission: 'shell', patterns: [command] }, policy);
    const start = performance.now();
    const results = [
      check('cat ' + '*'.repeat(64) + 'x'), check('cat ' + '*a'.repeat(64) + 'x'),
      check('cat ' + '*a'.repeat(64) + 'x', { sensitivePaths: ['a'.repeat(128)] }),
    ];
    console.log(JSON.stringify({ results, elapsed: performance.now() - start }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 }));
  assert.deepEqual(result.results, [claude('cat *x'), false, false]);
  assert.ok(result.elapsed < 50, `${result.elapsed} ms`);
});

const fix2Cases = [
  ['option values cannot suppress destructive flags', true, [
    'git clean -f -e -n', 'git clean -fd -e -n', 'git clean -f --exclude -n', 'git clean -f -e-n',
    'git clean -f --exclude=-n', 'git clean -fe-n', 'git clean -ef -f', 'git clean -f --excl -n',
    'git restore -s -S src/a', 'git restore --source -S src/a',
    'git push -o -n --force origin main', 'git branch -u -n -f main',
    'git switch -C synthetic main', 'git switch --force-create synthetic main', 'git checkout -B synthetic main',
    'git branch --contains -f main', 'git tag --contains -f release',
  ]],
  ['option values do not become destructive flags or operands', false, [
    'git clean -n', 'git clean -fn', 'git clean --dry-run -f', 'git clean -nfd',
    'git clean -e-n', 'git clean --exclude=-x',
    'git push -o --force origin main', 'git push -o-f origin main', 'git push --push-option --force origin main',
    'git push --push-option=--force origin main', 'git push -o +main origin main',
    'git branch -u -f feature', 'git branch -u-f feature', 'git branch --set-upstream-to --force feature',
    'git tag -m -d release', 'git tag -m-d release', 'git tag --message --delete release', 'git tag --message=--delete release',
    'git checkout -b -f', 'git checkout -b-f', 'git checkout -b .', 'git checkout --orphan .',
    'git rm --pathspec-from-file -f', 'git rm --pathspec-from-file=--force',
    'git stash push -m drop', 'git update-ref -m -d refs/heads/feature HEAD',
    'git status', 'git log', 'git diff', 'git push origin main', 'git branch -d feature',
    'git checkout main', 'git stash', 'ls', 'cat README.md', 'npm test', 'git commit -m "$MSG"',
  ]],
  ['git environment assignments require the user', true, [
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!rm -rf .' git x",
    "GIT_SSH_COMMAND='synthetic-helper' git push origin main", "GIT_PAGER='rm -rf x' git log",
    'GIT_EXTERNAL_DIFF=synthetic git diff', 'env GIT_SSH_COMMAND=synthetic git push origin main',
    'GIT_PAGER=cat git log', 'GIT_DIR=x git reset --hard', 'GIT_WORK_TREE=x git clean -f',
    'GIT_DIR=x git status', 'GIT_AUTHOR_NAME=Synthetic git status',
    'GIT_SSH_COMMAND=synthetic timeout 5 git push origin main',
    'timeout 5 env GIT_EDITOR=synthetic git commit -m safe',
    'env -i GIT_PAGER=synthetic sh -c "git log"', 'PAGER=synthetic sh -c "git log"',
    'export GIT_CONFIG_COUNT=1; echo safe', 'declare -x GIT_CONFIG_KEY_0=alias.x; git x',
    'typeset -x GIT_CONFIG_VALUE_0=synthetic; git x', 'export GIT_PAGER; ls',
    'export PAGER=synthetic; git log', 'declare -x EDITOR=synthetic; git commit -m safe',
    'typeset -x VISUAL=synthetic; git commit -m safe',
    ...['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SSH', 'GIT_EDITOR',
      'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_PROXY_COMMAND', 'PAGER', 'EDITOR', 'VISUAL']
      .flatMap((name) => [`${name}=synthetic git status`, `env ${name}=synthetic git status`]),
  ]],
  ['harmless assignments keep benign commands free', false, [
    'GIT_TERMINAL_PROMPT=0 git status', 'GIT_TRACE=1 git status', 'GIT_TRACE_SETUP=1 env git status',
    'SYNTHETIC=value git status', 'env SYNTHETIC=value git log', 'PAGER=synthetic cat README.md',
    'EDITOR=synthetic npm test', 'export SYNTHETIC=value; git status',
  ]],
  ['git command execution options require the user', true, [
    'git rebase -x "rm -rf ." main', 'git rebase --exec "rm -rf ." main',
    'git rebase -i --exec=synthetic main', 'git rebase -ixsynthetic main',
    'git submodule foreach "rm -rf ."', 'git submodule --quiet foreach "rm -rf ."',
    'git bisect run rm -rf x', 'git difftool -x synthetic', 'git difftool --extcmd=synthetic', 'git filter-repo',
    ...['fetch', 'pull', 'clone', 'ls-remote', 'archive'].flatMap((command) => [
      `git ${command} --upload-pack synthetic origin`, `git ${command} --upload-pack=synthetic origin`,
      `git ${command} -u synthetic origin`, `git ${command} -usynthetic origin`,
      `git ${command} --receive-pack synthetic origin`, `git ${command} --receive-pack=synthetic origin`,
    ]),
    'git push --receive-pack=synthetic origin main',
  ]],
  ['additional wrappers inspect commands and scripts', true, [
    'taskset 1 git reset --hard', 'taskset -c 0 git reset --hard', 'taskset --cpu-list=0 git reset --hard',
    'unshare --mount --pid --fork git reset --hard', 'unshare -r git reset --hard',
    'unshare --map-users 0,0,1 --map-groups 0,0,1 git reset --hard',
    'chroot / git reset --hard', 'chroot --userspec=synthetic / git reset --hard',
    'su -c "git reset --hard"', 'su root -c "git reset --hard"', 'su --command="git reset --hard"',
    'ssh h git reset --hard', 'ssh -p 22 h "echo safe; git reset --hard"',
    'ssh h "su -c \'git reset --hard\'"',
  ]],
  ['benign additional wrappers', false, [
    'taskset 1 git status', 'taskset -c 0 git log', 'taskset --cpu-list=0 git status',
    'unshare --mount --pid --fork git status', 'unshare -r git status', 'chroot / git status',
    'unshare --map-users 0,0,1 --map-groups 0,0,1 git status',
    'su -c "git status"', 'su root -c "git status"', 'ssh h git status', 'ssh -p 22 h "cat README.md"',
  ]],
  ['sensitive brace, ANSI-C and dynamic paths', true, [
    'cat .e{nv,x}', 'cat .en{v,}', String.raw`cat $'\x2eenv'`, String.raw`cat $'\056env'`,
    String.raw`cat $'\u002eenv'`, String.raw`cat $'\U0000002eenv'`, 'cat .env$IFS',
    String.raw`cat $'\456env'`, String.raw`cat $'.env\c@x'`, 'cat src/${X:-a,b}/.e{nv,x}',
    'cat ".env$IFS"', 'cat .e${SUFFIX}', 'cat --file=.e{nv,x}',
    'cat ' + '{a,b}'.repeat(7), 'cat .e{nv,{x,y}}', 'cat nested/.env$IFS',
  ]],
  ['benign brace, ANSI-C and dynamic paths', false, [
    'cat $FILE', 'cat src/$X', 'cat README.md', 'cat src/{a,b}.mjs',
    'cat ' + '{a,b}'.repeat(6), String.raw`cat $'README\x2emd'`,
    String.raw`cat $'it\'s-safe.txt'`, 'cat src/${FILE}', 'cat src/"$X"',
    'cat src/${X:-a,b}/README.{md,txt}',
  ]],
];
for (const [group, expected, commands] of fix2Cases) {
  for (const command of commands) {
    test(`F11 fix2: ${group}: ${command}`, () => {
      assert.equal(claude(command), expected, command);
      if (expected) {
        const request = { permission: 'shell', patterns: [command], metadata: { command } };
        assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
      }
    });
  }
}

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
    '--exec-path', '-C /repo --no-pager -c core.quotePath=false',
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
