import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAgent, resolveModel, profileRules } from '../../plugins/opc/scripts/lib/context.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { F3_PROVIDERS, F3_AGENTS, F3_OPENCODE_CONFIG, F3_TEST_CONFIG, F3_MODELS } from '../fixtures/f3-fake.mjs';

const config = { ...DEFAULT_CONFIG, ...F3_TEST_CONFIG };
const ctx = { config, err: () => {} };
const discovery = { catalog: buildCatalog(F3_PROVIDERS), opencodeConfig: F3_OPENCODE_CONFIG, agents: F3_AGENTS };
const policy = config.policy;

test('requireAgent: existence, mode, policy and pinned model', () => {
  assert.equal(requireAgent(discovery, 'general', policy, { modes: ['subagent', 'all'] }).name, 'general');
  assert.throws(() => requireAgent(discovery, 'build', policy, { modes: ['subagent', 'all'] }), (e) => e.exitCode === 2 && e.code === 'AGENT_MODE');
  assert.throws(() => requireAgent(discovery, 'nope', policy), (e) => e.exitCode === 2 && e.code === 'UNKNOWN_AGENT');
  assert.throws(() => requireAgent(discovery, 'work-secret', policy), (e) => e.exitCode === 4);
  assert.throws(() => requireAgent(discovery, 'pinned-sub', policy), (e) => e.exitCode === 4);
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
  const rules = profileRules(ctx, 'read-only', [{ permission: 'task', pattern: 'explore', action: 'allow' }]);
  assert.deepEqual(rules[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.deepEqual(rules.at(-1), { permission: 'task', pattern: 'explore', action: 'allow' });
  assert.ok(profileRules(ctx, 'write').some((r) => r.permission === 'external_directory' && r.action === 'deny'));
});
