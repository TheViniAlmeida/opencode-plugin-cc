import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema, validateSchema, clusterFindings } from '../../plugins/opc/scripts/lib/conclave.mjs';

const assets = loadConclaveAssets();
const SCENARIOS = ['conclave-opinion', 'conclave-debate', 'conclave-member-timeout', 'conclave-member-structured-error', 'conclave-self-identify', 'conclave-review', 'judge-ok'];
const MODELS = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3'];
function body(modelID, schema, text) {
  return { text: `${text}\n\nReturn one JSON object matching this schema:\n${JSON.stringify(schema)}`,
    model: { providerID: 'omniroute-personal', id: modelID } };
}
async function emitted(name, requestBody) {
  const { default: scenario } = await import(`../fixtures/scenarios/${name}.mjs`);
  const turns = [];
  const fake = { state: { sessions: { ses_test: { model: requestBody.model } } }, emitTurn: (_sessionID, turn) => turns.push(turn) };
  scenario.onPrompt(fake, 'ses_test', { text: requestBody.text });
  return turns[0] ?? null;
}
function outputOf(turn) {
  const match = turn?.text?.match(/^```json\n([\s\S]+)\n```$/);
  assert.ok(match, 'o V2 deve responder com um bloco JSON');
  return JSON.parse(match[1]);
}

test('scenario failures are limited to their intended family and round', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  const cases = [
    ['conclave-member-timeout', 'member', 'kimi', 'missing'],
    ['conclave-member-timeout', 'debate', 'kimi', 'missing'],
    ['conclave-member-structured-error', 'member', 'qwen', 'malformed'],
    ['conclave-opinion', 'judge', '*', 'malformed'],
  ];
  for (const name of SCENARIOS.filter((n) => n !== 'conclave-review')) {
    for (const modelID of MODELS) {
      for (const [kind, schema, prompt] of [['member', member, 'q'], ['debate', debate, '<peer_labels>A, C</peer_labels>'], ['judge', synthesis, '<labels>A, B</labels>']]) {
        const turn = await emitted(name, body(modelID, schema, prompt));
        const family = ['deepseek', 'qwen', 'kimi'].find((part) => modelID.includes(part));
        const intended = cases.find(([scenario, round, target]) => scenario === name && round === kind && (target === family || target === '*'));
        if (intended?.[3] === 'missing') assert.equal(turn, null, `${name} ${kind} ${family}`);
        else if (intended?.[3] === 'malformed') assert.doesNotMatch(turn.text, /^```json\n/);
        else assert.deepEqual(validateSchema(outputOf(turn), schema), [], `${name} ${modelID} ${kind}`);
      }
    }
  }
});

test('debate scenario flips changed only for the deepseek member', async () => {
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const changed = [];
  for (const modelID of MODELS) changed.push(outputOf(await emitted('conclave-debate', body(modelID, debate, '<peer_labels>A, C</peer_labels>'))).changed);
  assert.deepEqual(changed, [true, false, false]);
});

test('review scenario returns the fixture findings', async () => {
  const { REVIEWS } = await import('../fixtures/scenarios/conclave-review.mjs');
  const reviewSchema = structuredClone(assets.schemas.review);
  for (const [index, modelID] of MODELS.entries()) {
    const family = ['deepseek', 'qwen', 'kimi'][index];
    const output = outputOf(await emitted('conclave-review', body(modelID, reviewSchema, 'diff')));
    assert.deepEqual(output, REVIEWS[family]);
    assert.ok(output.findings.length > 0);
  }
});

test('review scenario keeps judge classification with findings before the contract', async () => {
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  const answers = '<answer label="A">\n{"verdict":"needs-attention","findings":[{"title":"Division by zero when count is 0"}]}\n</answer>';
  const turn = await emitted('conclave-review', body(MODELS[2], synthesis, `<labels>A, B</labels>\n${answers}`));
  assert.deepEqual(validateSchema(outputOf(turn), synthesis), []);
});

test('review scenario findings overlap as the acceptance tests expect', async () => {
  const reviewSchema = structuredClone(assets.schemas.review);
  const byLabel = {};
  for (const [label, modelID] of [['A', MODELS[0]], ['B', MODELS[1]], ['C', MODELS[2]]]) {
    byLabel[label] = outputOf(await emitted('conclave-review', body(modelID, reviewSchema, 'diff'))).findings;
  }
  const clusters = clusterFindings(byLabel);
  const shape = clusters.map((c) => [c.file, c.line_start, c.agreement.text]).sort((x, y) => String(x).localeCompare(String(y)));
  assert.deepEqual(shape, [
    ['src/calc.js', 10, '2/3'], ['src/calc.js', 30, '1/3'], ['src/list.js', 40, '1/3'],
    ['src/list.js', 5, '1/3'], [null, 1, '1/3'], [null, 1, '1/3'],
  ].sort((x, y) => String(x).localeCompare(String(y))));
});

test('self-identify scenario names model, provider and vendor', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const text = JSON.stringify(outputOf(await emitted('conclave-self-identify', body(MODELS[1], member, 'q'))));
  assert.match(text, /qwen3\.8-max/);
  assert.match(text, /omniroute-personal/);
  assert.match(text, /Alibaba/);
});
