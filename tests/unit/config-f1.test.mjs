import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, CONFIG_SCHEMA, validateConfigShape, mergeConfig, findSecretLikeKeys, isLockedKey, isWorkspaceKey,
  schemaFor, keyNeedsServer, isSecretLikeSetting,
} from '../../plugins/opc/scripts/lib/config.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';

test('DEFAULT_CONFIG is valid against CONFIG_SCHEMA and neutral', () => {
  assert.deepEqual(validateConfigShape(DEFAULT_CONFIG, { source: 'default' }), { errors: [], warnings: [] });
  assert.deepEqual(DEFAULT_CONFIG.policy.models, { allow: [], deny: [] });
  assert.deepEqual(DEFAULT_CONFIG.aliases, {});
  assert.equal(DEFAULT_CONFIG.policy.approver, 'user');
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.policy));
});

test('validateConfigShape: type errors, unknown keys and secret-looking keys', () => {
  const { errors, warnings } = validateConfigShape({
    defaultModel: 42,
    stopGate: { enabled: 'yes' },
    policy: { approver: 'robot', models: { allow: 'x' } },
    conclave: { rounds: 9 },
    permissionProfiles: { bad: [{ permission: 'bash', pattern: 'x', action: 'always' }] },
    mystery: true,
    server: { configOverride: { provider: { p: { options: { apiKey: 'x' } } } } },
    githubToken: 'nope',
  }, { source: 'global' });
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['conclave.rounds', 'defaultModel', 'permissionProfiles', 'policy.approver', 'policy.models.allow', 'stopGate.enabled']);
  const warnPaths = warnings.map((w) => w.path);
  assert.ok(warnPaths.includes('mystery'));
  assert.ok(warnPaths.includes('githubToken'));
  assert.ok(warnPaths.includes('server.configOverride.provider.p.options.apiKey'));
  assert.ok(warnings.find((w) => w.path === 'githubToken' && w.code === 'SECRET_LIKE_KEY').message.includes('secret'));
  assert.ok(warnings.find((w) => w.path === 'mystery').code === 'UNKNOWN_KEY');
});

test('validateConfigShape: non-object config is an error', () => {
  assert.equal(validateConfigShape([], { source: 'workspace' }).errors.length, 1);
  assert.deepEqual(validateConfigShape(null), { errors: [], warnings: [] });
});

test('findSecretLikeKeys: token/password/secret/apikey at any depth', () => {
  assert.deepEqual(findSecretLikeKeys({ a: { API_KEY: 1, b: [{ password: 2 }] }, secretSauce: 3, fine: 4, key: 5, server: { key: 6 }, provider: { privateKey: 7 }, x: { api_key: 8 }, authToken: 9, dbPassword: 10, keybinds: 11, keyboard: 12, keymap: 13, monkey: 14 }).sort(), ['a.API_KEY', 'a.b.0.password', 'authToken', 'dbPassword', 'key', 'provider.privateKey', 'secretSauce', 'server.key', 'x.api_key']);
});

test('isSecretLikeSetting: matches the final path segment with key boundaries', () => {
  for (const setting of ['key', 'server.key', 'provider.privateKey', 'x.api_key', 'authToken', 'dbPassword']) assert.equal(isSecretLikeSetting(setting), true, setting);
  for (const setting of ['keybinds', 'keyboard', 'keymap', 'defaultModel', 'monkey', 'turkey', 'keys']) assert.equal(isSecretLikeSetting(setting), false, setting);
});

test('isLockedKey / isWorkspaceKey', () => {
  for (const k of ['policy', 'policy.approver', 'policy.models.allow', 'permissionProfiles.x', 'server.configOverride', 'server.configOverride.share', 'server']) assert.ok(isLockedKey(k), k);
  for (const k of ['defaultModel', 'server.bootTimeoutSec', 'aliases.fast', 'stopGate.enabled']) assert.ok(!isLockedKey(k), k);
  assert.ok(isWorkspaceKey('policy.models.deny'));
  assert.ok(isWorkspaceKey('aliases.fast'));
  assert.ok(isWorkspaceKey('routing.tasks.ask'));
  assert.ok(!isWorkspaceKey('policy.approver'));
  assert.ok(!isWorkspaceKey('jobs.maxActive'));
  assert.ok(!isWorkspaceKey('stopGate.enabled'));
});

test('mergeConfig: global over defaults; restrictive workspace merge', () => {
  const global = {
    defaultModel: `${MV}/opencode-go/deepseek-v4.1-flash`,
    policy: { providers: { deny: [EQ] }, models: { allow: [`${MV}/*`] }, agents: { deny: ['work-*'] }, approver: 'claude' },
  };
  const workspace = {
    defaultModel: `${MV}/opencode-go/kimi-k3`,
    aliases: { k3: `${MV}/opencode-go/kimi-k3` },
    policy: {
      providers: { deny: ['anthropic'] },
      models: { allow: [`${MV}/opencode-go/*`, 'anthropic/*'], deny: ['*/qwen*'] },
      agents: { allow: ['build', 'plan'] },
      approver: 'claude',
      sensitivePaths: ['*.sqlite'],
    },
    permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
    server: { configOverride: { share: 'auto' }, bootTimeoutSec: 5 },
    jobs: { maxActive: 64 },
    stopGate: { enabled: true, model: 'fast' },
  };
  const { config, warnings } = mergeConfig(global, workspace);
  assert.equal(config.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(config.aliases.k3, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(config.policy.providers.deny, [EQ, 'anthropic']);
  assert.deepEqual(config.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(config.policy.models.allowWorkspace, [`${MV}/opencode-go/*`, 'anthropic/*']);
  assert.deepEqual(config.policy.models.deny, ['*/qwen*']);
  assert.deepEqual(config.policy.agents.allowWorkspace, ['build', 'plan']);
  assert.equal(config.policy.approver, 'claude', 'global approver kept');
  assert.ok(config.policy.sensitivePaths.includes('*.sqlite'));
  assert.ok(config.policy.sensitivePaths.includes('*.env'));
  assert.deepEqual(config.permissionProfiles, {});
  assert.deepEqual(config.server.configOverride, { share: 'disabled' });
  assert.equal(config.server.bootTimeoutSec, 60);
  assert.equal(config.jobs.maxActive, 8);
  assert.equal(config.stopGate.enabled, false);
  assert.equal(config.stopGate.model, 'fast');
  const w = warnings.map((x) => x.path);
  for (const p of ['policy.approver', 'permissionProfiles', 'server', 'server.configOverride', 'jobs', 'stopGate.enabled', 'policy.models.allow']) assert.ok(w.includes(p), `warning for ${p}`);
  assert.match(warnings.find((x) => x.path === 'policy.models.allow').message, /anthropic\/\*.*intersection/);
  assert.equal(validateConfigShape(config, { source: 'effective' }).errors.length, 0);
});

test('mergeConfig: missing files give DEFAULT_CONFIG and no warnings', () => {
  const { config, warnings } = mergeConfig(null, undefined);
  assert.deepEqual(config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  assert.deepEqual(warnings, []);
});

test('schemaFor: exact keys and map entries', () => {
  assert.equal(schemaFor('defaultModel').type, 'model');
  assert.equal(schemaFor('aliases.fast').type, 'model');
  assert.equal(schemaFor('routing.tasks.ask').type, 'modelref-list');
  assert.equal(schemaFor('permissionProfiles.npm-test-only').type, 'rules');
  assert.equal(schemaFor('server.configOverride.share').type, 'json');
  assert.equal(schemaFor('nope'), null);
  assert.equal(schemaFor('routing.tasks.ask.deeper'), null);
  for (const key of ['constructor', '__proto__', 'toString', 'routing.unknownFlag']) assert.equal(schemaFor(key), null);
  assert.ok(Object.keys(CONFIG_SCHEMA).length > 40);
});

test('modelref-list-map entries reject empty strings', () => {
  const errors = validateConfigShape({ routing: { tasks: { ask: [''] } } }).errors;
  assert.ok(errors.some((error) => ['routing.tasks', 'routing.tasks.ask'].includes(error.path)));
});

test('workspace unknown nested keys are warned and dropped', () => {
  const { config, warnings } = mergeConfig({}, { routing: { unknownFlag: true, tasks: { ask: ['prov/model'] } } });
  assert.ok(warnings.some((warning) => warning.path === 'routing.unknownFlag' && warning.code === 'WORKSPACE_IGNORED'));
  assert.deepEqual(config.routing, { tasks: { ask: ['prov/model'] }, tiers: {}, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } });
});

test('keyNeedsServer', () => {
  for (const k of ['defaultModel', 'reviewModel', 'aliases.fast', 'routing.tasks.ask', 'defaultAgent', 'defaultVariant', 'defaultProvider', 'conclave.judge']) assert.ok(keyNeedsServer(k), k);
  for (const k of ['stopGate.enabled', 'policy.models.allow', 'jobs.maxActive']) assert.ok(!keyNeedsServer(k), k);
});
