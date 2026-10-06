import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_DESTRUCTIVE_BASH, buildPermissionRules, checkReply, invariantRules, planPermissionSwitch, requiresUser, bridgeModeOf,
} from '../../plugins/opc/scripts/lib/policy.mjs';
import { UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { READ_ONLY_RULES, NPM_TEST_ONLY_RULES } from '../fixtures/expected-rules-f2a.mjs';

const policy = {
  sensitivePaths: ['*.env', '**/.ssh/**'],
  tools: { deny: ['gitlab_*'] },
  destructiveBash: ['make nuke*'],
  agents: { deny: ['work-*'] },
};
const r = (permission, pattern, action) => ({ permission, pattern, action });
const INVARIANTS = [
  r('external_directory', '*', 'deny'),
  r('read', '*.env', 'deny'), r('grep', '*.env', 'deny'), r('glob', '*.env', 'deny'), r('list', '*.env', 'deny'),
  r('read', '**/.ssh/**', 'deny'), r('grep', '**/.ssh/**', 'deny'), r('glob', '**/.ssh/**', 'deny'), r('list', '**/.ssh/**', 'deny'),
  r('task', 'work-*', 'deny'),
  r('gitlab_*', '*', 'deny'),
];
const INVARIANTS_RO = [INVARIANTS[0], r('grep', '*', 'deny'), ...INVARIANTS.slice(1)];

test('read-only: deny-all, allows, invariants, doom_loop deny — exact order', () => {
  const rules = buildPermissionRules('read-only', { policy, deniedAgentGlobs: ['work-*'] });
  assert.deepEqual(rules, [
    r('*', '*', 'deny'),
    r('read', '*', 'allow'), r('glob', '*', 'allow'), r('list', '*', 'allow'),
    r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'),
    ...INVARIANTS_RO,
    r('doom_loop', '*', 'deny'),
  ]);
  assert.ok(!rules.some((x) => x.permission === 'bash' && x.action !== 'deny'));
});

test('F2a expected read-only fixtures exactly match the profile builder', () => {
  const opts = { policy: { sensitivePaths: ['*.env', '**/.ssh/**'], tools: { deny: ['gitlab_*'] }, destructiveBash: ['make nuke*'] }, deniedAgentGlobs: ['work-*'] };
  assert.deepEqual(READ_ONLY_RULES, buildPermissionRules('read-only', opts));
  assert.deepEqual(NPM_TEST_ONLY_RULES, buildPermissionRules('custom:npm-test-only', {
    ...opts, permissionProfiles: { 'npm-test-only': [{ permission: 'bash', pattern: 'npm test', action: 'allow' }] },
  }));
});

test('write: only invariants + destructive asks (builtin then policy) + doom_loop ask', () => {
  const rules = buildPermissionRules('write', { policy, deniedAgentGlobs: ['work-*'] });
  const asks = [...BUILTIN_DESTRUCTIVE_BASH, 'make nuke*'].map((p) => r('bash', p, 'ask'));
  assert.deepEqual(rules, [...INVARIANTS, ...asks, r('doom_loop', '*', 'ask')]);
  assert.equal(BUILTIN_DESTRUCTIVE_BASH.length, 28);
  assert.ok(!rules.some((x) => x.permission === 'grep' && x.pattern === '*' && x.action === 'deny'));
});

test('custom: read-only base + custom rules + invariants; bash allow brings destructive asks', () => {
  const permissionProfiles = { 'npm-test-only': [{ permission: 'bash', pattern: 'npm test', action: 'allow' }], docs: [{ permission: 'edit', pattern: 'docs/*', action: 'allow' }] };
  const rules = buildPermissionRules('custom:npm-test-only', { policy, permissionProfiles, deniedAgentGlobs: [] });
  assert.deepEqual(rules.slice(0, 8), [
    r('*', '*', 'deny'), r('read', '*', 'allow'), r('glob', '*', 'allow'), r('list', '*', 'allow'),
    r('lsp', '*', 'allow'), r('skill', '*', 'allow'), r('todowrite', '*', 'allow'), r('bash', 'npm test', 'allow'),
  ]);
  assert.ok(rules.some((x) => x.permission === 'bash' && x.pattern === 'rm -rf*' && x.action === 'ask'));
  assert.deepEqual(rules.at(-1), r('doom_loop', '*', 'deny'));
  const docs = buildPermissionRules('custom:docs', { policy, permissionProfiles });
  assert.ok(!docs.some((x) => x.permission === 'bash'));
});

test('unknown or malformed profiles are usage errors', () => {
  assert.throws(() => buildPermissionRules('everything', { policy }), UsageError);
  assert.throws(() => buildPermissionRules('custom:nope', { policy, permissionProfiles: {} }), UsageError);
  assert.throws(() => buildPermissionRules('custom:bad', { policy, permissionProfiles: { bad: [{ permission: 'bash', pattern: '*', action: 'always' }] } }), UsageError);
});

test('default sensitive paths apply when policy has none', () => {
  const rules = invariantRules('read-only', { policy: {} });
  assert.ok(rules.some((x) => x.permission === 'read' && x.pattern === '*.pem' && x.action === 'deny'));
});

test('bridgeModeOf: read-only auto-rejects, others bridge', () => {
  assert.equal(bridgeModeOf('read-only'), 'auto-reject');
  assert.equal(bridgeModeOf('write'), 'bridge');
  assert.equal(bridgeModeOf('custom:x'), 'bridge');
});

test('requiresUser: destructive bash, external_directory, sensitive paths', () => {
  assert.equal(requiresUser({ permission: 'shell', patterns: ['rm -rf build'] }, policy), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['ls -la'] }, policy), false);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['rm -rf build'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['make nuke all'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['psql -c "DROP TABLE x"'] }, policy), true);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['ls -la'] }, policy), false);
  assert.equal(requiresUser({ permission: 'bash', patterns: ['ls'], metadata: { command: 'git push --force origin main' } }, policy), true);
  assert.equal(requiresUser({ permission: 'external_directory', patterns: ['/etc/*'] }, policy), true);
  assert.equal(requiresUser({ permission: 'read', patterns: ['/ws/app/.env'] }, policy), true);
  assert.equal(requiresUser({ permission: 'edit', patterns: ['/home/u/.ssh/config'] }, policy), true);
  assert.equal(requiresUser({ permission: 'edit', patterns: ['src/a.js'] }, policy), false);
  assert.equal(requiresUser(null, policy), true);
});

test('requiresUser: detects destructive commands in compound and wrapped segments', () => {
  for (const command of [
    'echo ok && rm -rf /x',
    'true; git push --force',
    'cat x | xargs rm -rf',
    'sudo rm -rf /x',
    '$(rm -rf /x)',
  ]) {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }, policy), true, command);
  }
  assert.equal(requiresUser({ permission: 'bash', patterns: ['npm test && git status'] }, policy), false);
});

test('requiresUser: recursively inspects nested substitutions and shell groups', () => {
  for (const command of [
    'echo $(echo $(rm -rf /x))',
    'echo `echo \\`rm -rf /x\\``',
    'a=$(b $(git push --force))',
    '(echo (rm -rf /x))',
    '{ echo { rm -rf /x; }; }',
  ]) {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }, policy), true, command);
  }
  assert.equal(requiresUser({ permission: 'bash', patterns: ['echo $(echo $(printf safe))'] }, policy), false);
});

test('checkReply: never always; approver user needs confirmation; claude only for destructive', () => {
  const destructive = { permission: 'bash', patterns: ['rm -rf build'] };
  const benign = { permission: 'bash', patterns: ['ls'] };
  assert.deepEqual(checkReply({ approver: 'claude', request: benign, reply: 'always', policy }).code, 'INVALID_REPLY');
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'maybe', policy }).code, 'INVALID_REPLY');
  assert.equal(checkReply({ approver: 'user', request: destructive, reply: 'reject', policy }).ok, true);
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'once', policy }).code, 'NEEDS_USER');
  assert.equal(checkReply({ approver: 'user', request: benign, reply: 'once', confirmedByUser: true, policy }).ok, true);
  assert.equal(checkReply({ approver: 'claude', request: benign, reply: 'once', policy }).ok, true);
  assert.equal(checkReply({ approver: 'claude', request: destructive, reply: 'once', policy }).code, 'NEEDS_USER');
  assert.equal(checkReply({ approver: 'claude', request: destructive, reply: 'once', confirmedByUser: true, policy }).ok, true);
});

test('policy errors and approval reasons are PT-BR and truncate echoed values', () => {
  assert.throws(() => buildPermissionRules('custom:abcdefghijklmnop', { policy, permissionProfiles: {} }), (err) => {
    assert.match(err.message, /não está definido/);
    assert.match(err.message, /abcdefghijkl…/);
    return true;
  });
  const invalid = checkReply({ approver: 'user', request: {}, reply: 'abcdefghijklmnop', policy });
  assert.match(invalid.reason, /resposta inválida/);
  assert.match(invalid.reason, /abcdefghijkl…/);
  const needsUser = checkReply({ approver: 'claude', request: { permission: 'bash', patterns: ['sudo rm -rf /x'] }, reply: 'once', policy });
  assert.match(needsUser.reason, /destrutiva/);
  assert.match(needsUser.reason, /--confirmed-by-user/);
});

test('planPermissionSwitch: none when tail matches; patch only with leading catch-all under append', () => {
  const ro = buildPermissionRules('read-only', { policy });
  const wr = buildPermissionRules('write', { policy });
  assert.equal(planPermissionSwitch(ro, ro), 'none');
  assert.equal(planPermissionSwitch([...wr, ...ro], ro), 'none');
  assert.equal(planPermissionSwitch(wr, ro), 'patch');
  assert.throws(() => planPermissionSwitch(ro, wr), (err) => err.code === 'PROFILE_SWITCH_UNSUPPORTED' && err.exitCode === 2);
  assert.equal(planPermissionSwitch(ro, wr, 'replace'), 'patch');
  assert.equal(planPermissionSwitch(undefined, ro), 'patch');
});

const wrappedDestructive = [
  'bash -c "rm -rf /tmp/x"', 'sh -c "rm -rf /tmp/x"',
  'zsh -c "rm -rf /tmp/x"', 'dash -c "rm -rf /tmp/x"',
  'bash -lc "env X=1 sh -c \'rm -rf /tmp/x\'"',
  'eval "rm -rf /tmp/x"', 'exec -a custom rm -rf /tmp/x',
  'env -u NAME X=1 rm -rf /tmp/x', 'xargs -I {} -n 1 sh -c "rm -rf /tmp/x"',
  'sudo -u root rm -rf /tmp/x', 'doas -u root rm -rf /tmp/x',
  'nohup rm -rf /tmp/x', 'time -p rm -rf /tmp/x',
  'nice -n 10 rm -rf /tmp/x', 'command -- rm -rf /tmp/x',
  'builtin eval "rm -rf /tmp/x"', 'find . -exec rm -rf {} \\;',
  'find . -delete', 'echo $(bash -c "rm -rf /tmp/x")',
  'echo `sh -c "rm -rf /tmp/x"`',
];
for (const command of wrappedDestructive) {
  test(`gate 2: wrapper requires user: ${command}`, () => {
    const request = { permission: 'bash', patterns: [command] };
    assert.equal(requiresUser(request), true);
    assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
    assert.equal(checkReply({ approver: 'claude', request, reply: 'once', confirmedByUser: true }).ok, true);
    assert.equal(requiresUser({ permission: 'bash', patterns: [], metadata: { command } }), true);
  });
}
for (const command of ['bash -c "unterminated', 'cat <<EOF\ntext\nEOF', '$COMMAND harmless', 'env X=1 "$COMMAND"', 'sudo --unknown-option value ls']) {
  test(`gate 2: ambiguous shell fails closed: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }), true);
  });
}

for (const command of [
  "bash -c 'if true; then rm -rf /tmp/x; fi'",
  'xargs -I CMD CMD', 'source commands.sh',
  'echo safe&rm -rf /tmp/x', '/bin/sh -c "/bin/rm -rf /tmp/x"',
]) {
  test(`gate 2: indirect or unsupported shell syntax requires user: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }), true);
  });
}
for (const command of [
  'bash -c "git status"', "sh -c 'env X=1 nice -n 2 git status'",
  'eval "git status"', 'exec git status', 'env X=1 git status',
  'sudo -u root git status', 'doas -u root git status',
  'nohup git status', 'time -p git status', 'nice -n 2 git status',
  'command -- git status', 'builtin printf safe', 'find . -exec printf {} \\;',
  'echo $(sh -c "git status")', 'echo `sh -c "git status"`',
]) {
  test(`gate 2: inspectable benign wrapper stays eligible: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }), false);
  });
}

for (const command of [
  'xargs rm', 'xargs git', 'xargs -I {} sh -c "echo {}"',
  'find . -exec sh -c "echo {}" \\;', 'find . -exec pre{}post \\;',
]) {
  test(`gate 2: runtime arguments cannot bypass inspection: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'bash', patterns: [command] }), true);
  });
}
