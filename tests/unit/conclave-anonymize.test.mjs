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

test('catalog names include full ids, phrases and curated families and vendors', () => {
  for (const name of ['omniroute-personal', DS, 'opencode-go/qwen3.8-max', 'kimi-k3', 'Qwen3.8 Max', 'alibaba', 'moonshot', 'anthropic', 'openai', 'chatgpt']) assert.ok(known.exact.includes(name), `exact should include ${name}`);
  for (const word of ['omniroute', 'personal', 'opencode-go', 'sonnet']) assert.ok(!known.exact.includes(word));
  assert.deepEqual([...known.families].sort(), ['anthropic', 'claude', 'deepseek', 'gpt', 'kimi', 'openai', 'qwen'].sort());
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

test('short exact model ids containing digits are redacted without matching short prose', () => {
  const names = buildKnownNames(makeCatalog([
    { providerID: 'openai', modelID: 'o3', full: 'openai/o3', name: 'o3' },
    { providerID: 'deepseek', modelID: 'R1', full: 'deepseek/R1', name: 'R1' },
    { providerID: 'acme', modelID: 'k2', full: 'acme/k2', name: 'k2' },
  ], ['openai', 'deepseek', 'acme']));

  assert.ok(names.exact.includes('o3'));
  assert.ok(names.exact.includes('R1'));
  assert.ok(names.exact.includes('k2'));
  assert.equal(anonymize('I am o3 from openai.', names), `I am ${REDACTED_NAME} from ${REDACTED_NAME}.`);
  assert.equal(anonymize('R1 thinks', names), `${REDACTED_NAME} thinks`);
  assert.equal(anonymize('go ahead, a max of 2', names), 'go ahead, a max of 2');
});

test('a large catalog preserves ordinary prose while redacting model identification', () => {
  const prose = 'For a small Node.js CLI with zero runtime dependencies, tools in the ecosystem are free and built-in; users cannot add comments.';
  const rows = Array.from({ length: 8501 }, (_, i) => ({ full: `synthetic-provider/archive/model-${i}`, name: `Synthetic Model ${i}` }));
  rows.push(
    { full: 'free-tools/small', name: 'Free Tools Small' },
    { full: 'ecosystem-users/zero-shot-1', name: 'Zero Shot 1' },
    { full: 'for-coding/comments', name: 'For Coding' },
    { full: 'synthetic-provider/redacted', name: 'Redacted' },
    ...catalog.models,
  );
  const names = buildKnownNames(makeCatalog(rows, []));
  assert.equal(anonymize(prose, names), prose);
  for (const word of ['for', 'small', 'zero', 'shot', 'tools', 'ecosystem', 'free', 'users', 'comments', 'redacted', 'synthetic', 'archive']) {
    assert.ok(!names.exact.includes(word), `not an exact name: ${word}`);
    assert.ok(!names.families.includes(word), `not a family: ${word}`);
  }
  for (const identification of ['I am Qwen3.7-Flash by Alibaba', 'as DeepSeek V4', 'Kimi K2.6 from Moonshot', DS, 'opencode-go/qwen3.8-max']) {
    const clean = anonymize(identification, names);
    assert.doesNotMatch(clean, FORBIDDEN);
    assert.ok(clean.includes(REDACTED_NAME));
    assert.doesNotMatch(clean, /\[\[redacted\]\]/);
    assert.equal(anonymize(clean, names), clean);
  }
  for (const phrase of ['Free Tools Small', 'For Coding', 'zero-shot-1', 'free-tools/small', 'free-tools']) assert.equal(anonymize(phrase, names), REDACTED_NAME);
});

test('short catalog providers, numbers, versions and code tokens never redact prose', () => {
  const names = buildKnownNames(makeCatalog([
    { providerID: 'nan', modelID: 'gemma4', full: 'nan/gemma4', name: 'Gemma 4' },
    { providerID: 'bee', modelID: 'bee-buzz', full: 'bee/bee-buzz', name: 'Bee Buzz 1.0' },
    { providerID: 'router', modelID: 'router/e2e', full: 'router/router/e2e', name: 'End-to-End Encrypted' },
    { providerID: 'v0', modelID: 'v0-1.5-lg', full: 'v0/v0-1.5-lg', name: 'v0-1.5-lg' },
    { providerID: 'acme', modelID: '18', full: 'acme/18', name: '18' },
    { providerID: 'acme', modelID: 'utf8', full: 'acme/utf8', name: 'utf8' },
  ], ['nan', 'bee', 'router', 'v0', 'acme']));
  const prose = 'average() returns NaN (or nan) for an empty list; e2e tests on Node 18 and v0 of the API decode utf8 like a bee.';
  assert.equal(anonymize(prose, names), prose);
  assert.equal(anonymize('I am gemma4 via nan/gemma4', names), `I am ${REDACTED_NAME} via ${REDACTED_NAME}`);
  assert.equal(anonymize('v0-1.5-lg', names), REDACTED_NAME);
  const member = { providerID: 'acme-route', modelID: 'v0', full: 'acme-route/v0', name: 'v0' };
  const withMember = buildKnownNames(makeCatalog([member], ['acme-route']), { extraModels: [member] });
  assert.equal(anonymize('I am v0.', withMember), `I am ${REDACTED_NAME}.`);
});

test('only participant models supply uncurated families; provider words only when specific', () => {
  const model = { providerID: 'acme-cloud', modelID: 'private-route/zeta-sonnet-9-pro', full: 'acme-cloud/private-route/zeta-sonnet-9-pro', name: 'Unrelated Display Phrase' };
  const catalogNames = buildKnownNames(makeCatalog([model], []));
  const participantNames = buildKnownNames(makeCatalog([model], []), { extraModels: [model] });
  const prose = 'Zeta-10 from acme using Sonnet 8';
  assert.equal(anonymize(prose, catalogNames), prose);
  assert.equal(anonymize(prose, participantNames), `${REDACTED_NAME} from acme using ${REDACTED_NAME} 8`);
  assert.equal(anonymize('served by acme-cloud', participantNames), `served by ${REDACTED_NAME}`);
  const gateway = { providerID: 'omniroute-personal', modelID: 'cmd/deepseek/deepseek-v4-flash', full: 'omniroute-personal/cmd/deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' };
  const gatewayNames = buildKnownNames(makeCatalog([gateway], []), { extraModels: [gateway] });
  assert.equal(anonymize('This personal project runs a cmd script; I am DeepSeek via omniroute-personal.', gatewayNames), `This personal project runs a cmd script; I am ${REDACTED_NAME} via ${REDACTED_NAME}.`);
  assert.equal(anonymize('[DeepSeek] and [deepseek-v4-flash]', gatewayNames), `${REDACTED_NAME} and ${REDACTED_NAME}`);
  assert.ok(participantNames.exact.includes('private-route'));
  for (const word of ['cloud', 'pro', 'unrelated', 'display', 'phrase']) {
    assert.ok(!participantNames.exact.includes(word));
    assert.ok(!participantNames.families.includes(word));
  }
  assert.equal(anonymize('Unrelated Display Phrase', participantNames), REDACTED_NAME);
});

test('catalog display phrases never supply families even when they contain curated words', () => {
  const names = buildKnownNames(makeCatalog([{ full: 'acme/plain', name: 'Qwen Quasar Edition' }], []));
  assert.equal(anonymize('Qwen Quasar Edition', names), REDACTED_NAME);
  assert.equal(anonymize('Quasar Edition and Quasar2', names), 'Quasar Edition and Quasar2');
  assert.ok(!names.families.includes('quasar'));
});

test('curated short and formerly generic families come from the vendor map', () => {
  const names = buildKnownNames(makeCatalog([
    { full: 'acme/yi-34b', name: 'Yi 34B' },
    { full: 'acme/command-r-plus', name: 'Command R Plus' },
    { full: 'acme/nemotron-70b', name: 'Nemotron 70B' },
  ], []));
  assert.ok(names.families.includes('yi'));
  assert.ok(names.families.includes('command'));
  assert.equal(anonymize('Yi-35b by 01ai, Command by Cohere, Nemotron by Nvidia', names), `${REDACTED_NAME} by ${REDACTED_NAME}, ${REDACTED_NAME} by ${REDACTED_NAME}, ${REDACTED_NAME} by ${REDACTED_NAME}`);
  const prose = 'Generators yield results, and the commander avoids the nemotroncache identifier.';
  assert.equal(anonymize(prose, names), prose);
});

test('replacement markers cannot be rematched by exact names or families across passes', () => {
  for (const names of [
    { exact: ['redacted', 'Qwen3.7-Flash'], families: ['redacted'] },
    { exact: ['Qwen3.7-Flash'], families: ['red', 'qwen'] },
    ['redacted', 'Qwen3.7-Flash'],
  ]) {
    const clean = anonymize(`${REDACTED_NAME} Qwen3.7-Flash`, names);
    assert.equal(clean, `${REDACTED_NAME} ${REDACTED_NAME}`);
    assert.equal(anonymize(clean, names), clean);
    assert.doesNotMatch(clean, /\[\[redacted\]\]/);
  }
});
