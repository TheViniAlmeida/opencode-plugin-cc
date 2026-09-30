import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { fillTemplate, projectContextBlock } from '../../plugins/opc/scripts/lib/prompts.mjs';

test('strict fillTemplate replaces every placeholder and keeps $ sequences literal', () => {
  const out = fillTemplate('Q: {{QUESTION}} / {{QUESTION}} by {{SELF_LABEL}}', { QUESTION: 'cost $& of `x` $(y)', SELF_LABEL: 'B' }, { strict: true });
  assert.equal(out, 'Q: cost $& of `x` $(y) / cost $& of `x` $(y) by B');
});
test('strict fillTemplate fails fast on placeholders without a value', () => {
  assert.throws(() => fillTemplate('{{QUESTION}} {{MISSING}}', { QUESTION: 'q' }, { strict: true }), (err) => err.code === 'TEMPLATE_UNFILLED');
});
test('strict fillTemplate does not re-scan inserted values', () => {
  assert.equal(fillTemplate('<q>{{QUESTION}}</q>', { QUESTION: 'what is {{ROUND}}?' }, { strict: true }), '<q>what is {{ROUND}}?</q>');
});
test('conclave prompts carry exactly the placeholders runtime fills', () => {
  const { prompts } = loadConclaveAssets();
  const names = (t) => [...new Set([...t.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(names(prompts.member), ['PROJECT_CONTEXT', 'QUESTION', 'SELF_LABEL']);
  assert.deepEqual(names(prompts.debate), ['PEER_LABELS', 'PEER_RESPONSES', 'QUESTION', 'ROUND', 'SELF_LABEL', 'TOTAL_ROUNDS']);
  assert.deepEqual(names(prompts.judge), ['DEBATE_NOTE', 'LABELS', 'MODE', 'QUESTION', 'RESPONSES', 'REVIEW_SUMMARY']);
});
test('conclave prompts never name a model vendor or provider', () => {
  const { prompts } = loadConclaveAssets();
  for (const text of [prompts.member, prompts.debate, prompts.judge]) assert.doesNotMatch(text, /deepseek|qwen|kimi|claude|anthropic|openai|gpt|gemini|omniroute|opencode/i);
});
test('debate and judge prompts expose labels in machine-readable tags', () => {
  const { prompts } = loadConclaveAssets();
  assert.match(prompts.debate, /<self_label>\{\{SELF_LABEL\}\}<\/self_label>/);
  assert.match(prompts.debate, /<peer_labels>\{\{PEER_LABELS\}\}<\/peer_labels>/);
  assert.match(prompts.judge, /<labels>\{\{LABELS\}\}<\/labels>/);
});
test('loadConclaveAssets reads schemas as objects', () => {
  const { schemas } = loadConclaveAssets();
  assert.equal(schemas.member.title, 'ConclaveMember');
  assert.equal(schemas.synthesis.title, 'ConclaveSynthesis');
  assert.equal(typeof schemas.review, 'object');
});
test('projectContextBlock renders only configured fields', () => {
  assert.equal(projectContextBlock(null), '');
  assert.equal(projectContextBlock({ goal: '', scope: [], taskTypes: [] }), '');
  assert.equal(projectContextBlock({ goal: 'Ship opc', scope: ['plugins/'], taskTypes: [] }), '<project_context>\ngoal: Ship opc\nscope: plugins/\n</project_context>');
  assert.equal(projectContextBlock({ taskTypes: ['bugfix'] }), '<project_context>\ntask types: bugfix\n</project_context>');
});
test('review prompt is loaded through loadPrompt without attribution comment', () => {
  const { prompts } = loadConclaveAssets();
  assert.doesNotMatch(prompts.review, /^\s*<!--/);
  assert.match(prompts.review, /\{\{REVIEW_INPUT\}\}/);
});
