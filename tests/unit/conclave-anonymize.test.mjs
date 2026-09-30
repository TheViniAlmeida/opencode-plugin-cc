import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, anonymizeValue, buildKnownNames, REDACTED_NAME } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, DS, QW, KM } from './_conclave-fixtures.mjs';

const catalog = makeCatalog([
  { full: DS, name: 'DeepSeek V4.1 Flash' },
  { full: QW, name: 'Qwen3.8 Max' },
  { full: KM, name: 'Kimi K3' },
  { full: 'openai/gpt-5.2-mini', name: 'GPT-5.2 Mini' },
  { full: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
], ['omniroute-personal', 'openai', 'anthropic']);
const known = buildKnownNames(catalog);
const FORBIDDEN = /deepseek|qwen|kimi|omniroute|opencode-go|alibaba|moonshot|openai|chatgpt|gpt|anthropic|claude/i;

test('buildKnownNames collects provider ids, model ids, names, families and vendors', () => {
  for (const name of ['omniroute-personal', 'omniroute', DS, 'opencode-go/qwen3.8-max', 'kimi-k3', 'opencode-go', 'Qwen3.8 Max', 'alibaba', 'moonshot', 'anthropic', 'openai', 'chatgpt']) assert.ok(known.exact.includes(name), `exact should include ${name}`);
  assert.deepEqual([...known.families].sort(), ['claude', 'deepseek', 'gpt', 'kimi', 'qwen', 'sonnet'].sort());
});
test('generic words from model ids never become family words', () => { for (const generic of ['flash', 'max', 'mini', 'pro', 'go', 'opencode']) assert.ok(!known.families.includes(generic), `${generic} must not be a family word`); });
test('self-identification is scrubbed, with case and version variants', () => {
  const text = 'I am DeepSeek V4.1 Flash via omniroute-personal. As QWEN3.8-max (by Alibaba) and kimi-k3 from Moonshot, we agree; ChatGPT and gpt-5 disagree, Claude too.';
  const out = anonymize(text, known); assert.doesNotMatch(out, FORBIDDEN); assert.ok(out.includes(REDACTED_NAME)); assert.ok(out.endsWith('too.'), 'sentence punctuation is kept');
});
test('full ids with slashes are removed as a whole', () => { assert.equal(anonymize(`member model: ${KM}!`, known), `member model: ${REDACTED_NAME}!`); });
test('ordinary prose with generic words is left intact', () => { const text = 'The flash storage has a max size of 2 GB; go read the code, it is open and pro-grade.'; assert.equal(anonymize(text, known), text); });
test('family words inside unrelated identifiers are not matched mid-word', () => { assert.equal(anonymize('the variable mydeepseekcache stays', known), 'the variable mydeepseekcache stays'); });
test('anonymize accepts a plain array of exact names', () => { assert.equal(anonymize('Hello Acme-Model and acme-model', ['Acme-Model']), `Hello ${REDACTED_NAME} and ${REDACTED_NAME}`); });
test('anonymize tolerates empty inputs', () => { assert.equal(anonymize('', known), ''); assert.equal(anonymize(undefined, known), ''); assert.equal(anonymize('nothing to hide', { exact: [], families: [] }), 'nothing to hide'); });
test('anonymizeValue walks nested objects and arrays, keeping keys and non-strings', () => {
  const value = { position: 'Kimi says yes', confidence: 0.4, evidence: [{ file: 'src/a.js', note: 'checked by qwen3.8-max', line_start: 1 }], critiques: [{ target: 'B', point: 'DeepSeek is wrong' }] };
  const out = anonymizeValue(value, known); assert.doesNotMatch(JSON.stringify(out), FORBIDDEN); assert.equal(out.confidence, 0.4); assert.equal(out.evidence[0].line_start, 1); assert.equal(out.evidence[0].file, 'src/a.js'); assert.equal(out.critiques[0].target, 'B');
});
test('extra models are covered even when missing from the catalog', () => {
  const names = buildKnownNames(makeCatalog([], []), { extraModels: [{ providerID: 'acme', modelID: 'zeta-9-pro', full: 'acme/zeta-9-pro', name: 'Zeta 9 Pro' }] });
  assert.equal(anonymize('I am Zeta-9 from acme', names), `I am ${REDACTED_NAME} from ${REDACTED_NAME}`);
});
