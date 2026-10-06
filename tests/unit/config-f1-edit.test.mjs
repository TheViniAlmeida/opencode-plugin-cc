import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG, mergeConfig, coerceValue, applyConfigEdit, unsetPath, normalizeEditValue, modelRefsIn,
  validateAgainstServer, policyViolations, configPaths,
} from '../../plugins/opc/scripts/lib/config.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog({ providers: load('provider.json'), models: load('model.json') });
const agents = load('agent.json').map((agent) => ({ ...agent, name: agent.id }));
const MV = 'omniroute-personal';
const EQ = 'omniroute-work';
const fresh = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

test('coerceValue: per type', () => {
  assert.equal(coerceValue('stopGate.enabled', 'true'), true);
  assert.equal(coerceValue('jobs.maxActive', '4'), 4);
  assert.equal(coerceValue('defaultModel', 'null'), null);
  assert.deepEqual(coerceValue('policy.models.deny', 'a/*,b/*'), ['a/*', 'b/*']);
  assert.deepEqual(coerceValue('policy.models.deny', '["a/*","b/*"]'), ['a/*', 'b/*']);
  assert.deepEqual(coerceValue('policy.models.deny', '["a/*","b/*"]'), ['a/*', 'b/*']);
  for (const raw of ['[123]', '[{"x":1}]', '[a,b']) {
    assert.throws(() => coerceValue('policy.models.deny', raw), (e) => e.code === 'INVALID_VALUE' && e.exitCode === 2 && /lista|array|JSON/i.test(e.message));
  }
  assert.deepEqual(coerceValue('aliases', '{"fast":"p/m"}'), { fast: 'p/m' });
  assert.equal(coerceValue('policy.approver', 'claude'), 'claude');
  assert.throws(() => coerceValue('policy.approver', 'robot'), (e) => e.code === 'INVALID_VALUE' && e.exitCode === 2);
  assert.throws(() => coerceValue('jobs.maxActive', '999'), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => coerceValue('jobs.maxActive', 'four'), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => coerceValue('nope.key', 'x'), (e) => e.code === 'UNKNOWN_KEY');
  assert.throws(() => coerceValue('aliases', '{bad'), (e) => e.code === 'INVALID_VALUE');
});

test('applyConfigEdit: set, unset, add (dedupe), remove', () => {
  let cfg = applyConfigEdit({}, 'set', 'stopGate.enabled', true);
  assert.deepEqual(cfg, { stopGate: { enabled: true } });
  cfg = applyConfigEdit(cfg, 'add', 'policy.models.deny', 'a/*');
  cfg = applyConfigEdit(cfg, 'add', 'policy.models.deny', 'a/*');
  assert.deepEqual(cfg.policy.models.deny, ['a/*']);
  cfg = applyConfigEdit(cfg, 'remove', 'policy.models.deny', 'a/*');
  assert.deepEqual(cfg.policy.models.deny, []);
  assert.throws(() => applyConfigEdit(cfg, 'remove', 'policy.models.deny', 'zzz'), (e) => e.code === 'NOT_IN_LIST');
  assert.throws(() => applyConfigEdit(cfg, 'add', 'defaultModel', 'x'), (e) => e.code === 'NOT_A_LIST');
  cfg = applyConfigEdit(cfg, 'unset', 'stopGate.enabled');
  assert.deepEqual(cfg.stopGate, {});
  assert.deepEqual(unsetPath({ a: 1 }, 'b.c'), { a: 1 });
});

test('normalizeEditValue: short names become full ids, aliases stay', () => {
  const aliases = { strong: `${MV}/opencode-go/qwen3.8-max` };
  const opts = { catalog, aliases, defaultProvider: MV };
  assert.equal(normalizeEditValue('defaultModel', 'opencode-go/kimi-k3', opts), `${MV}/opencode-go/kimi-k3`);
  assert.equal(normalizeEditValue('reviewModel', 'strong', opts), 'strong');
  assert.equal(normalizeEditValue('conclave.judge', 'claude', opts), 'claude');
  assert.deepEqual(normalizeEditValue('routing.tasks.ask', ['strong', 'opencode-go/kimi-k3'], opts), ['strong', `${MV}/opencode-go/kimi-k3`]);
  assert.deepEqual(normalizeEditValue('aliases', { fast: 'opencode-go/deepseek-v4.1-flash' }, opts), { fast: `${MV}/opencode-go/deepseek-v4.1-flash` });
  assert.throws(() => normalizeEditValue('defaultModel', 'opencode/big-pickle', opts), (e) => e.code === 'AMBIGUOUS_MODEL');
  assert.equal(normalizeEditValue('policy.approver', 'user', opts), 'user');
});

test('modelRefsIn lists every model reference with its path', () => {
  const refs = modelRefsIn({ ...DEFAULT_CONFIG, defaultModel: 'p/m', aliases: { fast: 'p/f' }, routing: { tasks: { ask: ['fast', 'p/x'] }, tiers: {} } });
  assert.deepEqual(refs.map((r) => r.path), ['defaultModel', 'orchestrate.synthesizer', 'conclave.judge', 'aliases.fast', 'routing.tasks.ask[0]', 'routing.tasks.ask[1]']);
  assert.deepEqual(refs.map((r) => r.kind), ['model', 'modelref-or-claude', 'modelref-or-claude', 'model', 'modelref', 'modelref']);
});

test('validateAgainstServer: unknown model, invalid variant, broken alias, alias chain, agent checks', () => {
  const cfg = {
    ...fresh(),
    defaultProvider: 'openai',
    defaultModel: `${MV}/opencode-go/kimi-k3`,
    defaultVariant: 'ultra',
    defaultAgent: 'general',
    aliases: { fast: `${MV}/opencode-go/deepseek-v4.1-flash`, gone: `${MV}/opencode-go/removed-model`, chain: 'fast' },
    reviewModel: 'gone',
    stopGate: { enabled: false, model: `${MV}/opencode-go/nope` },
    routing: { tasks: { ask: ['fast'] }, tiers: {}, fallback: DEFAULT_CONFIG.routing.fallback },
    conclave: { ...DEFAULT_CONFIG.conclave, defaultPool: 'missing' },
  };
  const { errors } = validateAgainstServer(cfg, { catalog, agents });
  const byPath = Object.fromEntries(errors.map((e) => [e.path, e.code]));
  assert.equal(byPath.defaultProvider, 'UNKNOWN_PROVIDER');
  assert.equal(byPath.defaultVariant, 'UNKNOWN_VARIANT');
  assert.equal(byPath.defaultAgent, 'AGENT_MODE');
  assert.equal(byPath['aliases.gone'], 'UNKNOWN_MODEL');
  assert.equal(byPath['aliases.chain'], 'BROKEN_ALIAS');
  assert.equal(byPath.reviewModel, 'BROKEN_ALIAS');
  assert.equal(byPath['stopGate.model'], 'UNKNOWN_MODEL');
  assert.equal(byPath['conclave.defaultPool'], 'UNKNOWN_POOL');
  assert.equal(byPath['routing.tasks.ask[0]'], undefined, 'valid alias reference');
  const ok = validateAgainstServer({ ...fresh(), defaultModel: `${MV}/opencode-go/kimi-k3`, defaultVariant: 'high', defaultAgent: 'build' }, { catalog, agents });
  assert.deepEqual(ok.errors, []);
});

test('validateAgainstServer: stored full ids are read without defaultProvider prefix', () => {
  const cfg = { ...fresh(), defaultProvider: MV, defaultModel: 'opencode/big-pickle' };
  assert.deepEqual(validateAgainstServer(cfg, { catalog, agents }).errors, []);
});

test('defaultVariant falls back to the OpenCode default model', () => {
  const cfg = { ...fresh(), defaultVariant: 'high' };
  const { errors } = validateAgainstServer(cfg, { catalog, agents, opencodeConfig: { model: `${MV}/opencode-go/qwen3.8-max` } });
  assert.deepEqual(errors, []);
});

test('policyViolations: denied defaults, aliases and pinned agent models', () => {
  const cfg = mergeConfig({
    defaultProvider: EQ,
    defaultModel: `${EQ}/opencode-go/kimi-k3`,
    defaultAgent: 'docs-writer',
    aliases: { eqk3: `${EQ}/opencode-go/kimi-k3` },
    reviewModel: 'eqk3',
    policy: { providers: { deny: [EQ] }, models: { deny: ['*/qwen3.8-max'] } },
  }, {}).config;
  const v = policyViolations(cfg, { catalog, agents });
  const paths = v.map((e) => e.path).sort();
  assert.deepEqual(paths, ['aliases.eqk3', 'defaultModel', 'defaultProvider', 'reviewModel']);
  assert.ok(v.every((e) => e.code === 'POLICY_DENIED'));
});

test('policyViolations evaluates denied unknown referenced model ids', () => {
  const cfg = mergeConfig({
    defaultModel: 'blocked/model',
    policy: { models: { deny: ['blocked/*'] } },
  }, {}).config;
  assert.equal(validateAgainstServer(cfg, { catalog, agents }).errors.find((e) => e.path === 'defaultModel')?.code, 'UNKNOWN_MODEL');
  assert.ok(policyViolations(cfg, { catalog, agents }).some((e) => e.path === 'defaultModel' && e.code === 'POLICY_DENIED'));
});

for (const [op, value] of [['unset', undefined], ['set', null]]) {
  test(`workspace ${op} defaultModel ${String(value)} exposes the denied global model`, () => {
    const global = {
      defaultModel: `${EQ}/opencode-go/kimi-k3`,
      policy: { providers: { deny: [EQ] } },
    };
    const workspace = { defaultModel: `${MV}/opencode-go/kimi-k3` };
    const before = mergeConfig(global, workspace).config;
    const next = applyConfigEdit(workspace, op, 'defaultModel', value);
    const after = mergeConfig(global, next).config;

    assert.deepEqual(policyViolations(before, { catalog, agents }), []);
    assert.equal(after.defaultModel, global.defaultModel);
    for (const deps of [{ catalog, agents }, { catalog: undefined, agents: [] }]) {
      const denied = policyViolations(after, deps);
      assert.equal(denied.length, 1);
      assert.equal(denied[0].path, 'defaultModel');
      assert.equal(denied[0].code, 'POLICY_DENIED');
      assert.match(denied[0].message, /policy\.providers\.deny: omniroute-work/);
    }
    assert.equal(workspace.defaultModel, `${MV}/opencode-go/kimi-k3`, 'edit and merge preserve the original override');
  });
}

test('workspace null defaultModel inherits an allowed global model or the neutral default', () => {
  const workspace = { defaultModel: null };
  const inherited = mergeConfig({ defaultModel: `${MV}/opencode-go/kimi-k3` }, workspace).config;
  assert.equal(inherited.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(policyViolations(inherited, { catalog, agents }), []);
  assert.equal(mergeConfig({}, workspace).config.defaultModel, null);
  assert.equal(mergeConfig({ defaultModel: null }, {}).config.defaultModel, null);
});

test('configPaths', () => {
  assert.deepEqual(configPaths({ dataDir: '/d', workspaceRoot: '/w' }), { dataDir: '/d', global: '/d/config.json', workspace: '/w/.opc.json', draft: '/d/config.draft.json' });
});
