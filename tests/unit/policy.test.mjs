import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, assertAllowed, evaluateAgent, evaluateCommand, assertAgentUsable, assertCommandUsable, pinnedModelOf,
} from '../../plugins/opc/scripts/lib/policy.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const WORLD = {
  providers: { allow: [], deny: [EQ] },
  models: { allow: [`${MV}/opencode-go/*`, 'anthropic/*'], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: ['gitlab_*'] },
};

test('evaluate: empty policy allows everything', () => {
  assert.deepEqual(evaluate('model', `${EQ}/opencode-go/kimi-k3`, {}), { allowed: true });
  assert.deepEqual(evaluate('agent', 'work-deploy', undefined), { allowed: true });
});

test('evaluate: provider deny also denies its models', () => {
  const r = evaluate('model', `${EQ}/opencode-go/kimi-k3`, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /policy\.providers\.deny: omniroute-work/);
});

test('evaluate: model allow list with globs across slashes', () => {
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, WORLD).allowed, true);
  assert.equal(evaluate('model', 'anthropic/claude-opus-5-5', WORLD).allowed, true);
  const r = evaluate('model', `${MV}/cx/gpt-5.6-sol`, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /policy\.models\.allow \(global\)/);
});

test('evaluate: deny wins over allow', () => {
  const p = { models: { allow: ['*'], deny: ['*/kimi-*'] } };
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, p).allowed, false);
});

test('evaluate: workspace allow is an intersection (both lists must match)', () => {
  const p = { models: { allow: [`${MV}/*`], allowWorkspace: [`${MV}/opencode-go/kimi-*`], deny: [] } };
  assert.equal(evaluate('model', `${MV}/opencode-go/kimi-k3`, p).allowed, true);
  const r = evaluate('model', `${MV}/opencode-go/qwen3.8-max`, p);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /\.opc\.json/);
  const outside = evaluate('model', 'anthropic/claude-opus-5-5', { models: { allow: [`${MV}/*`], allowWorkspace: ['anthropic/*'] } });
  assert.equal(outside.allowed, false, 'workspace cannot widen the global allow');
});

test('evaluate: tools only have deny', () => {
  assert.equal(evaluate('tool', 'gitlab_list_mrs', WORLD).allowed, false);
  assert.equal(evaluate('tool', 'read', WORLD).allowed, true);
  assert.throws(() => evaluate('bogus', 'x', WORLD), TypeError);
});

test('assertAllowed: throws PolicyError (exit 4) with the rule', () => {
  assert.throws(() => assertAllowed('agent', 'work-reviewer', WORLD), (err) => {
    assert.equal(err.exitCode, 4);
    assert.equal(err.code, 'POLICY_DENIED');
    assert.equal(err.details.rule, 'policy.agents.deny: work-*');
    return true;
  });
  assert.deepEqual(assertAllowed('agent', 'build', WORLD), { allowed: true });
});

test('evaluateAgent: pinned model goes through the policy', () => {
  const pinned = { name: 'pinned-reviewer', model: { providerID: EQ, modelID: 'opencode-go/kimi-k3' } };
  assert.equal(pinnedModelOf(pinned), `${EQ}/opencode-go/kimi-k3`);
  const r = evaluateAgent(pinned, WORLD);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /^pinned model omniroute-work\/opencode-go\/kimi-k3/);
  assert.equal(evaluateAgent({ name: 'docs-writer', model: { providerID: MV, modelID: 'opencode-go/qwen3.8-max' } }, WORLD).allowed, true);
  assert.throws(() => assertAgentUsable(pinned, WORLD), (err) => err.exitCode === 4);
});

test('evaluateCommand: pinned model and pinned agent', () => {
  const agents = new Map([['work-deploy', { name: 'work-deploy' }]]);
  assert.equal(evaluateCommand({ name: 'docs', model: `${MV}/opencode-go/qwen3.8-max` }, WORLD).allowed, true);
  assert.equal(evaluateCommand({ name: 'work-release', model: `${EQ}/cx/gpt-5.5` }, WORLD).allowed, false);
  const r = evaluateCommand({ name: 'ship', agent: 'work-deploy' }, WORLD, agents);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /pinned agent work-deploy/);
  assert.throws(() => assertCommandUsable({ name: 'ship', agent: 'work-deploy' }, WORLD, agents), (err) => err.exitCode === 4);
});

test('pinned models also go through the provider policy (agent and command)', () => {
  const p = { providers: { allow: ['anthropic'], deny: [] }, models: { allow: ['*'], deny: [] } };
  const helper = { name: 'helper', model: { providerID: 'acme', modelID: 'm-1' } };
  const r = evaluateAgent(helper, p);
  assert.equal(r.allowed, false);
  assert.match(r.rule, /^pinned model acme\/m-1: policy\.providers\.allow \(global\)/);
  assert.throws(() => assertAgentUsable(helper, p), (err) => err.exitCode === 4);
  assert.equal(evaluateCommand({ name: 'c', model: 'acme/m-1' }, p).allowed, false);
  assert.equal(evaluateCommand({ name: 'c2', agent: 'helper' }, p, new Map([['helper', helper]])).allowed, false);
  assert.equal(evaluateAgent({ name: 'ok', model: { providerID: 'anthropic', modelID: 'claude-x' } }, p).allowed, true);
});
