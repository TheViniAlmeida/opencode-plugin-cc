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
const r = (action, resource, effect) => ({ action, resource, effect });
const INVARIANTS = [
  r('external_directory', '*', 'deny'),
  r('read', '*.env', 'deny'), r('grep', '*.env', 'deny'), r('glob', '*.env', 'deny'),
  r('read', '**/.ssh/**', 'deny'), r('grep', '**/.ssh/**', 'deny'), r('glob', '**/.ssh/**', 'deny'),
  r('subagent', 'work-*', 'deny'),
  r('gitlab_*', '*', 'deny'),
];
const INVARIANTS_RO = [INVARIANTS[0], r('grep', '*', 'deny'), ...INVARIANTS.slice(1)];

test('read-only V2: deny-all, allows and invariants in order', () => {
  const rules = buildPermissionRules('read-only', { policy, deniedAgentGlobs: ['work-*'] });
  assert.deepEqual(rules, [
    r('*', '*', 'deny'),
    r('read', '*', 'allow'), r('glob', '*', 'allow'), r('skill', '*', 'allow'), r('question', '*', 'allow'),
    ...INVARIANTS_RO,
    r('browser', '*', 'deny'),
  ]);
  assert.ok(!rules.some((x) => x.action === 'bash' && x.effect !== 'deny'));
});

test('F2a expected read-only fixtures exactly match the profile builder', () => {
  const opts = { policy: { sensitivePaths: ['*.env', '**/.ssh/**'], tools: { deny: ['gitlab_*'] }, destructiveBash: ['make nuke*'] }, deniedAgentGlobs: ['work-*'] };
  assert.deepEqual(READ_ONLY_RULES, buildPermissionRules('read-only', opts));
  assert.deepEqual(NPM_TEST_ONLY_RULES, buildPermissionRules('custom:npm-test-only', {
    ...opts, permissionProfiles: { 'npm-test-only': [{ action: 'shell', resource: 'npm test', effect: 'allow' }] },
  }));
});

test('write: invariants and destructive shell asks', () => {
  const rules = buildPermissionRules('write', { policy, deniedAgentGlobs: ['work-*'] });
  const asks = [...BUILTIN_DESTRUCTIVE_BASH, 'make nuke*'].map((p) => r('shell', p, 'ask'));
  assert.deepEqual(rules, [...INVARIANTS, ...asks, r('browser', '*', 'deny')]);
  assert.equal(BUILTIN_DESTRUCTIVE_BASH.length, 28);
  assert.ok(!rules.some((x) => x.action === 'grep' && x.resource === '*' && x.effect === 'deny'));
});

test('custom: read-only base + custom rules + invariants; shell allow brings destructive asks', () => {
  const permissionProfiles = { 'npm-test-only': [{ action: 'shell', resource: 'npm test', effect: 'allow' }], docs: [{ action: 'edit', resource: 'docs/*', effect: 'allow' }] };
  const rules = buildPermissionRules('custom:npm-test-only', { policy, permissionProfiles, deniedAgentGlobs: [] });
  assert.deepEqual(rules.slice(0, 6), [
    r('*', '*', 'deny'), r('read', '*', 'allow'), r('glob', '*', 'allow'), r('skill', '*', 'allow'), r('question', '*', 'allow'), r('shell', 'npm test', 'allow'),
  ]);
  assert.ok(rules.some((x) => x.action === 'shell' && x.resource === 'rm *' && x.effect === 'ask'));
  assert.deepEqual(rules.at(-1), r('browser', '*', 'deny'));
  const docs = buildPermissionRules('custom:docs', { policy, permissionProfiles });
  assert.ok(!docs.some((x) => x.action === 'shell'));
});

test('unknown or malformed profiles are usage errors', () => {
  assert.throws(() => buildPermissionRules('everything', { policy }), UsageError);
  assert.throws(() => buildPermissionRules('custom:nope', { policy, permissionProfiles: {} }), UsageError);
  assert.throws(() => buildPermissionRules('custom:bad', { policy, permissionProfiles: { bad: [{ action: 'shell', resource: '*', effect: 'always' }] } }), UsageError);
});

test('default sensitive paths apply when policy has none', () => {
  const rules = invariantRules('read-only', { policy: {} });
  assert.ok(rules.some((x) => x.action === 'read' && x.resource === '*.pem' && x.effect === 'deny'));
});

test('bridgeModeOf: read-only auto-rejects, others bridge', () => {
  assert.equal(bridgeModeOf('read-only'), 'auto-reject');
  assert.equal(bridgeModeOf('write'), 'bridge');
  assert.equal(bridgeModeOf('custom:x'), 'bridge');
});

test('requiresUser: destructive bash, external_directory, sensitive paths', () => {
  assert.equal(requiresUser({ permission: 'shell', patterns: ['rm -rf build'] }, policy), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['ls -la'] }, policy), false);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['rm -rf build'] }, policy), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['make nuke all'] }, policy), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['psql -c "DROP TABLE x"'] }, policy), true);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['ls -la'] }, policy), false);
  assert.equal(requiresUser({ permission: 'shell', patterns: ['ls'], metadata: { command: 'git push --force origin main' } }, policy), true);
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
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }, policy), true, command);
  }
  assert.equal(requiresUser({ permission: 'shell', patterns: ['npm test && git status'] }, policy), false);
});

test('requiresUser: recursively inspects nested substitutions and shell groups', () => {
  for (const command of [
    'echo $(echo $(rm -rf /x))',
    'echo `echo \\`rm -rf /x\\``',
    'a=$(b $(git push --force))',
    '(echo (rm -rf /x))',
    '{ echo { rm -rf /x; }; }',
  ]) {
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }, policy), true, command);
  }
  assert.equal(requiresUser({ permission: 'shell', patterns: ['echo $(echo $(printf safe))'] }, policy), false);
});

test('checkReply: never always; approver user needs confirmation; claude only for destructive', () => {
  const destructive = { permission: 'shell', patterns: ['rm -rf build'] };
  const benign = { permission: 'shell', patterns: ['ls'] };
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
  const needsUser = checkReply({ approver: 'claude', request: { permission: 'shell', patterns: ['sudo rm -rf /x'] }, reply: 'once', policy });
  assert.match(needsUser.reason, /destrutiva/);
  assert.match(needsUser.reason, /--confirmed-by-user/);
});

test('planPermissionSwitch replaces exact V2 lists', () => {
  const ro = buildPermissionRules('read-only', { policy });
  const wr = buildPermissionRules('write', { policy });
  assert.deepEqual(planPermissionSwitch(ro, ro), { kind: 'none' });
  assert.deepEqual(planPermissionSwitch([...wr, ...ro], ro), { kind: 'replace', rules: ro });
  assert.deepEqual(planPermissionSwitch(wr, ro), { kind: 'replace', rules: ro });
  assert.deepEqual(planPermissionSwitch(ro, wr), { kind: 'replace', rules: wr });
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
    const request = { permission: 'shell', patterns: [command] };
    assert.equal(requiresUser(request), true);
    assert.equal(checkReply({ approver: 'claude', request, reply: 'once' }).code, 'NEEDS_USER');
    assert.equal(checkReply({ approver: 'claude', request, reply: 'once', confirmedByUser: true }).ok, true);
    assert.equal(requiresUser({ permission: 'shell', patterns: [], metadata: { command } }), true);
  });
}
for (const command of ['bash -c "unterminated', 'cat <<EOF\ntext\nEOF', '$COMMAND harmless', 'env X=1 "$COMMAND"', 'sudo --unknown-option value ls']) {
  test(`gate 2: ambiguous shell fails closed: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }), true);
  });
}

for (const command of [
  "bash -c 'if true; then rm -rf /tmp/x; fi'",
  'xargs -I CMD CMD', 'source commands.sh',
  'echo safe&rm -rf /tmp/x', '/bin/sh -c "/bin/rm -rf /tmp/x"',
]) {
  test(`gate 2: indirect or unsupported shell syntax requires user: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }), true);
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
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }), false);
  });
}

for (const command of [
  'xargs rm', 'xargs git', 'xargs -I {} sh -c "echo {}"',
  'find . -exec sh -c "echo {}" \\;', 'find . -exec pre{}post \\;',
]) {
  test(`gate 2: runtime arguments cannot bypass inspection: ${command}`, () => {
    assert.equal(requiresUser({ permission: 'shell', patterns: [command] }), true);
  });
}
