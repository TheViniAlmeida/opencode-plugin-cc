import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDiscovery, requireAgent, resolveModel, profileRules } from '../../plugins/opc/scripts/lib/context.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { F3_PROVIDERS, F3_MODEL_CATALOG, F3_AGENTS, F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

const config = { ...DEFAULT_CONFIG, ...F3_TEST_CONFIG };
const ctx = { config, err: () => {} };
const DEFAULT_MODEL = { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' };
const discovery = await loadDiscovery({ providers: async () => F3_PROVIDERS, models: async () => F3_MODEL_CATALOG,
  defaultModel: async () => DEFAULT_MODEL, agents: async () => F3_AGENTS });
const policy = config.policy;

test('loadDiscovery uses V2 catalogs and reaches model selection', async () => {
  const calls = [];
  const api = {
    providers: async () => { calls.push('providers'); return F3_PROVIDERS; },
    models: async () => { calls.push('models'); return F3_MODEL_CATALOG; },
    defaultModel: async () => { calls.push('default'); return DEFAULT_MODEL; },
    agents: async () => { calls.push('agents'); return F3_AGENTS; },
  };
  const found = await loadDiscovery(api);
  assert.deepEqual(calls.sort(), ['agents', 'default', 'models', 'providers']);
  assert.equal(found.opencodeConfig.model, F3_MODELS.deepseek);
  assert.equal(resolveModel(ctx, found, 'task', 'fast').full, F3_MODELS.deepseek);
  assert.equal(found.catalog.byFull.get(F3_MODELS.deepseek).variants.includes('high'), true);
});

test('requireAgent: existence, mode and policy', () => {
  assert.equal(requireAgent(discovery, 'general', policy, { modes: ['subagent', 'all'] }).name, 'general');
  assert.throws(() => requireAgent(discovery, 'build', policy, { modes: ['subagent', 'all'] }), (e) => e.exitCode === 2 && e.code === 'AGENT_MODE');
  assert.throws(() => requireAgent(discovery, 'nope', policy), (e) => e.exitCode === 2 && e.code === 'UNKNOWN_AGENT');
  assert.throws(() => requireAgent(discovery, 'work-secret', policy), (e) => e.exitCode === 4);
});

test('resolveModel: alias, default and policy denial', () => {
  assert.equal(resolveModel(ctx, discovery, 'task', 'strong').full, F3_MODELS.qwen);
  assert.equal(resolveModel(ctx, discovery, 'task', null).full, F3_MODELS.deepseek);
  assert.throws(() => resolveModel(ctx, discovery, 'task', F3_MODELS.denied), (e) => e.exitCode === 4);
});

test('resolveModel checks the variant through F2a validateSelection (F1 validateVariant)', () => {
  assert.equal(resolveModel(ctx, discovery, 'task', 'fast').variant, null);
  assert.throws(() => resolveModel(ctx, discovery, 'task', 'fast', { variant: 'no-such-variant' }), (e) => e.exitCode === 2 && e.code === 'UNKNOWN_VARIANT');
});

test('profileRules: read-only starts with deny-all; extra rules go last', () => {
  const rules = profileRules(ctx, 'read-only', [{ action: 'subagent', resource: 'explore', effect: 'allow' }]);
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(rules.at(-1), { action: 'subagent', resource: 'explore', effect: 'allow' });
  assert.ok(profileRules(ctx, 'write').some((r) => r.action === 'external_directory' && r.effect === 'deny'));
});
