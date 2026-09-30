import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema, validateSchema, clusterFindings } from '../../plugins/opc/scripts/lib/conclave.mjs';

const assets = loadConclaveAssets();
const SCENARIOS = ['conclave-opinion', 'conclave-debate', 'conclave-member-timeout', 'conclave-member-structured-error', 'conclave-self-identify', 'conclave-review', 'judge-ok'];
const MODELS = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3'];

function body(modelID, schema, text, mode = 'tool') {
  const prompt = `${text}\n\nReturn one JSON object matching this schema:\n${JSON.stringify(schema)}`;
  return {
    model: { providerID: 'omniroute-personal', modelID },
    ...(mode === 'tool' ? { format: { type: 'json_schema', schema } } : {}),
    parts: [{ type: 'text', text: prompt }],
  };
}

async function emitted(name, requestBody) {
  const { default: scenario } = await import(`../fixtures/scenarios/${name}.mjs`);
  const turns = [];
  scenario.onPromptAsync({ emitTurn: (sessionID, turn) => turns.push(turn) }, 'ses_test', requestBody);
  return turns[0] ?? null;
}

function outputOf(turn, mode) {
  if (mode === 'tool') return turn?.structured;
  assert.equal(turn?.structured, undefined);
  const match = turn?.text?.match(/^```json\n([\s\S]+)\n```$/);
  assert.ok(match, 'text mode must return exactly one JSON fence');
  return JSON.parse(match[1]);
}

test('scenario failures are limited to their intended family, round and output mode', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  const cases = [
    ['conclave-member-timeout', 'member', 'kimi', 'missing'],
    ['conclave-member-timeout', 'debate', 'kimi', 'missing'],
    ['conclave-member-structured-error', 'member', 'qwen', 'error'],
    ['conclave-opinion', 'judge', '*', 'error'],
  ];
  for (const name of SCENARIOS.filter((n) => n !== 'conclave-review')) {
    for (const mode of ['tool', 'text']) {
      for (const modelID of MODELS) {
        for (const [kind, schema, prompt] of [['member', member, 'q'], ['debate', debate, '<peer_labels>A, C</peer_labels>'], ['judge', synthesis, '<labels>A, B</labels>']]) {
          const turn = await emitted(name, body(modelID, schema, prompt, mode));
          const family = ['deepseek', 'qwen', 'kimi'].find((part) => modelID.includes(part));
          const intended = cases.find(([scenario, round, target]) => scenario === name && round === kind && (target === family || target === '*'));
          if (intended?.[3] === 'missing') assert.equal(turn, null, `${name} ${kind} ${family} ${mode}`);
          else if (intended?.[3] === 'error' && mode === 'tool') assert.equal(turn?.error?.name, 'StructuredOutputError', `${name} ${kind} ${family} ${mode}`);
          else if (intended?.[3] === 'error' && mode === 'text') {
            assert.equal(turn?.error, undefined);
            assert.match(turn?.text ?? '', /cannot format|mostly agree/i);
            assert.equal(turn?.structured, undefined);
          } else {
            assert.ok(turn, `${name} ${kind} ${family} ${mode} should emit`);
            const output = outputOf(turn, mode);
            assert.deepEqual(validateSchema(output, schema), [], `${name} ${modelID} ${kind} ${mode}`);
          }
        }
      }
    }
  }
});

test('debate scenario flips changed only for the deepseek member', async () => {
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const changed = [];
  for (const modelID of MODELS) changed.push((await emitted('conclave-debate', body(modelID, debate, '<peer_labels>A, C</peer_labels>'))).structured.changed);
  assert.deepEqual(changed, [true, false, false]);
});

test('review scenario returns the fixture findings exactly in both output modes', async () => {
  const { REVIEWS } = await import('../fixtures/scenarios/conclave-review.mjs');
  const reviewSchema = structuredClone(assets.schemas.review);
  for (const [index, modelID] of MODELS.entries()) {
    const family = ['deepseek', 'qwen', 'kimi'][index];
    for (const mode of ['tool', 'text']) {
      const turn = await emitted('conclave-review', body(modelID, reviewSchema, 'diff', mode));
      const output = outputOf(turn, mode);
      assert.deepEqual(output, REVIEWS[family]);
      assert.ok(output.findings.length > 0);
    }
  }
});

test('review scenario: the judge prompt with findings before the contract is still a judge turn', async () => {
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  const answers = '<answer label="A">\n{"verdict":"needs-attention","findings":[{"title":"Division by zero when count is 0"}]}\n</answer>';
  for (const mode of ['tool', 'text']) {
    const turn = await emitted('conclave-review', body(MODELS[2], synthesis, `<labels>A, B</labels>\n${answers}`, mode));
    assert.deepEqual(validateSchema(outputOf(turn, mode), synthesis), [], mode);
  }
});

test('review scenario findings overlap as the acceptance tests expect', async () => {
  const reviewSchema = structuredClone(assets.schemas.review);
  const byLabel = {};
  for (const [label, modelID] of [['A', MODELS[0]], ['B', MODELS[1]], ['C', MODELS[2]]]) {
    byLabel[label] = outputOf(await emitted('conclave-review', body(modelID, reviewSchema, 'diff', 'text')), 'text').findings;
  }
  const clusters = clusterFindings(byLabel);
  const shape = clusters.map((c) => [c.file, c.line_start, c.agreement.text]).sort((x, y) => String(x).localeCompare(String(y)));
  assert.deepEqual(shape, [
    ['src/calc.js', 10, '2/3'],
    ['src/calc.js', 30, '1/3'],
    ['src/list.js', 40, '1/3'],
    ['src/list.js', 5, '1/3'],
    [null, 1, '1/3'],
    [null, 1, '1/3'],
  ].sort((x, y) => String(x).localeCompare(String(y))));
});

test('self-identify scenario really names model, provider and vendor', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const turn = await emitted('conclave-self-identify', body(MODELS[1], member, 'q'));
  const text = JSON.stringify(turn.structured);
  assert.match(text, /qwen3\.8-max/);
  assert.match(text, /omniroute-personal/);
  assert.match(text, /Alibaba/);
});
