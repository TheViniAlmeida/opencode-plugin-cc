import test from 'node:test';
import assert from 'node:assert/strict';
import { kindSpecificModel, resolveCandidates, validateSelection } from '../../plugins/opc/scripts/lib/routing.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { PolicyError, UsageError } from '../../plugins/opc/scripts/lib/opc-error.mjs';

const P = 'omniroute-personal';
const catalog = buildCatalog({
  connected: [P, 'anthropic'],
  default: {},
  all: [
    { id: P, name: 'Omni', models: {
      'opencode-go/deepseek-v4.1-flash': { id: 'opencode-go/deepseek-v4.1-flash', providerID: P, name: 'DeepSeek', variants: { high: {}, low: {} }, limit: { context: 128000, output: 8192 } },
      'opencode-go/qwen3.8-max': { id: 'opencode-go/qwen3.8-max', providerID: P, name: 'Qwen', variants: {}, limit: { context: 256000, output: 8192 } },
      'opencode-go/kimi-k3': { id: 'opencode-go/kimi-k3', providerID: P, name: 'Kimi', variants: { thinking: {} }, limit: { context: 200000, output: 8192 } },
      'abcdefghijklmnop': { id: 'abcdefghijklmnop', providerID: P, name: 'Long ID' },
    } },
    { id: 'anthropic', name: 'Anthropic', models: { 'claude-x': { id: 'claude-x', providerID: 'anthropic', name: 'X', variants: {} } } },
    { id: 'omniroute-work', name: 'EQ', models: { 'm': { id: 'm', providerID: 'omniroute-work', name: 'm' } } },
    { id: 'ollama', name: 'Ollama', models: { 'llama9': { id: 'llama9', providerID: 'ollama', name: 'llama9' } } },
  ],
});
const FLASH = `${P}/opencode-go/deepseek-v4.1-flash`;
const QWEN = `${P}/opencode-go/qwen3.8-max`;
const KIMI = `${P}/opencode-go/kimi-k3`;
const baseConfig = {
  defaultProvider: P,
  aliases: { fast: FLASH, strong: QWEN, k3: KIMI },
  routing: { tasks: { ask: ['fast', 'k3'], task: ['fast', 'strong'] }, tiers: { light: ['fast'], heavy: ['strong', 'k3'] } },
  policy: { providers: { deny: ['omniroute-work'] }, models: { allow: [], deny: [] } },
};

test('level 1: --model (alias, full with slashes, short name) wins, no fallback', () => {
  for (const model of ['fast', FLASH, 'opencode-go/deepseek-v4.1-flash']) {
    const r = resolveCandidates({ kind: 'ask', flags: { model, tier: 'heavy' }, config: baseConfig, catalog });
    assert.deepEqual(r.candidates.map((c) => c.full), [FLASH]);
    assert.equal(r.candidates[0].modelID, 'opencode-go/deepseek-v4.1-flash');
    assert.equal(r.candidates[0].source, 'flag');
    assert.equal(r.fallbackEligible, false);
  }
});

test('level 2: --tier list, eligible for fallback', () => {
  const r = resolveCandidates({ kind: 'ask', flags: { tier: 'heavy' }, config: baseConfig, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [QWEN, KIMI]);
  assert.equal(r.fallbackEligible, true);
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: 'nope' }, config: baseConfig, catalog }), (e) => e.code === 'INVALID_TIER');
});

test('level 3: kind-specific model beats the route', () => {
  const config = { ...baseConfig, reviewModel: 'strong', routing: { ...baseConfig.routing, tasks: { review: ['fast'] } } };
  const r = resolveCandidates({ kind: 'review', config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [QWEN]);
  assert.equal(r.candidates[0].source, 'kind');
  assert.equal(kindSpecificModel('judge', { conclave: { judge: 'claude' } }), null);
  assert.equal(kindSpecificModel('stop-gate', { stopGate: { model: 'k3' } }), 'k3');
  assert.equal(kindSpecificModel('task', baseConfig), null);
});

test('level 4 route; level 5 defaultModel; level 6 OpenCode default; level 7 error', () => {
  assert.deepEqual(resolveCandidates({ kind: 'ask', config: baseConfig, catalog }).candidates.map((c) => c.full), [FLASH, KIMI]);
  const noRoute = { ...baseConfig, routing: {}, defaultModel: KIMI };
  assert.deepEqual(resolveCandidates({ kind: 'plan', config: noRoute, catalog }).candidates.map((c) => c.full), [KIMI]);
  const bare = { defaultProvider: P, policy: {} };
  const r6 = resolveCandidates({ kind: 'plan', config: bare, catalog, opencodeConfig: { model: QWEN } });
  assert.equal(r6.candidates[0].source, 'opencode');
  assert.throws(() => resolveCandidates({ kind: 'plan', config: bare, catalog, opencodeConfig: {} }), (e) => e instanceof UsageError && e.code === 'NO_MODEL');
});

test('lists skip denied/invalid entries with warnings; all denied → PolicyError', () => {
  const config = { ...baseConfig, policy: { models: { deny: [KIMI] } }, routing: { tasks: { ask: ['k3', 'ghost', 'fast'] } } };
  const r = resolveCandidates({ kind: 'ask', config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [FLASH]);
  assert.equal(r.warnings.length, 2);
  assert.equal(r.fallbackEligible, false);
  const allDenied = { ...baseConfig, policy: { models: { deny: ['*'] } } };
  assert.throws(() => resolveCandidates({ kind: 'ask', config: allDenied, catalog }), PolicyError);
  const allInvalid = { ...baseConfig, routing: { tasks: { ask: ['ghost1', 'ghost2'] } } };
  assert.throws(() => resolveCandidates({ kind: 'ask', config: allInvalid, catalog }), (e) => e.code === 'NO_VALID_CANDIDATE');
});

test('single value denied → PolicyError; disconnected provider → usage error', () => {
  for (const model of ['omniroute-work/m', '=omniroute-work/m']) {
    assert.throws(() => resolveCandidates({ kind: 'task', flags: { model }, config: baseConfig, catalog }), (e) => {
      assert.ok(e instanceof PolicyError);
      assert.equal(e.code, 'POLICY_DENIED');
      assert.match(e.message, /provider omniroute-work negado pela política/);
      return true;
    });
  }
  assert.throws(() => resolveCandidates({ kind: 'task', flags: { model: 'ollama/llama9' }, config: baseConfig, catalog }), (e) => e instanceof UsageError && e.code === 'PROVIDER_NOT_CONNECTED');
});

test('routing messages preserve config identifiers and truncate invalid user values', () => {
  const longModel = `${P}/abcdefghijklmnop`;
  const modelDenied = { ...baseConfig, policy: { models: { deny: [longModel] } } };
  assert.throws(() => resolveCandidates({ kind: 'task', flags: { model: longModel }, config: modelDenied, catalog }), (e) => {
    assert.equal(e.code, 'POLICY_DENIED');
    assert.ok(e.message.includes(`modelo ${longModel} negado pela política`));
    assert.ok(e.message.includes(`policy.models.deny: ${longModel}`));
    return true;
  });
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: 'tier-abcdefghijk' }, config: baseConfig, catalog }), (e) => {
    assert.equal(e.code, 'INVALID_TIER');
    assert.match(e.message, /--tier deve ser um de: light, heavy \(recebido: "tier-abcdefg…"\)/);
    return true;
  });
  const longTier = 'tier-abcdefghijk';
  const invalidTierConfig = { ...baseConfig, routing: { ...baseConfig.routing, tiers: { ...baseConfig.routing.tiers, [longTier]: ['ghost'] } } };
  assert.throws(() => resolveCandidates({ kind: 'ask', flags: { tier: longTier }, config: invalidTierConfig, catalog }), (e) => {
    assert.equal(e.code, 'INVALID_TIER');
    assert.match(e.message, /tier-abcdefg…/);
    assert.ok(!e.message.includes(longTier));
    return true;
  });
  assert.throws(() => validateSelection({ candidate: { full: FLASH }, agentName: 'agent-abcdefghijkl', agents: [], catalog }), (e) => {
    assert.equal(e.code, 'UNKNOWN_AGENT');
    assert.match(e.message, /agente desconhecido "agent-abcdef…"/);
    return true;
  });
  const aliasRoute = { ...baseConfig, routing: { tasks: { ask: ['alias-abcdefghijk', 'fast'] } } };
  const skipped = resolveCandidates({ kind: 'ask', config: aliasRoute, catalog });
  assert.match(skipped.warnings[0], /ignorado alias-abcdefghijk/);
});

test('validateSelection: variant (F1 validateVariant), agent existence, policy (F1 assertAgentUsable), mode and pinned model', () => {
  const candidate = { full: FLASH };
  const agents = [
    { name: 'build', mode: 'primary' },
    { name: 'explore', mode: 'subagent' },
    { name: 'work-deploy', mode: 'primary' },
    { name: 'pinned', mode: 'all', model: { providerID: 'omniroute-work', modelID: 'm' } },
  ];
  const policy = { agents: { deny: ['work-*'] }, providers: { deny: ['omniroute-work'] } };
  assert.deepEqual(validateSelection({ candidate, variant: 'high', agentName: 'build', agents, catalog, policy }), { variant: 'high', agent: 'build' });
  assert.throws(() => validateSelection({ candidate, variant: 'ultra', agents, catalog, policy }), (e) => e instanceof UsageError && e.code === 'UNKNOWN_VARIANT');
  assert.throws(() => validateSelection({ candidate: { full: 'ghost/none' }, variant: 'high', agents, catalog, policy }), (e) => e.code === 'UNKNOWN_VARIANT');
  assert.deepEqual(validateSelection({ candidate, variant: '', agents, catalog, policy }), { variant: null, agent: null });
  assert.throws(() => validateSelection({ candidate, agentName: 'ghost', agents, catalog, policy }), (e) => e.code === 'UNKNOWN_AGENT');
  assert.throws(() => validateSelection({ candidate, agentName: 'explore', agents, catalog, policy }), (e) => e.code === 'AGENT_MODE');
  assert.throws(() => validateSelection({ candidate, agentName: 'work-deploy', agents, catalog, policy }), (e) => e instanceof PolicyError && e.code === 'POLICY_DENIED');
  // pinned model whose provider is denied: F1 assertAgentUsable checks the provider before the model
  assert.throws(() => validateSelection({ candidate, agentName: 'pinned', agents, catalog, policy }), PolicyError);
});
