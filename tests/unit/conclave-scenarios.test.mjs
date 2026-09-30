import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema, validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';

const assets = loadConclaveAssets();
const SCENARIOS = ['conclave-opinion', 'conclave-debate', 'conclave-member-timeout', 'conclave-member-structured-error', 'conclave-self-identify', 'conclave-review', 'judge-ok'];
const MODELS = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/qwen3.8-max', 'opencode-go/kimi-k3'];

function body(modelID, schema, text) {
  return { model: { providerID: 'omniroute-personal', modelID }, format: { type: 'json_schema', schema }, parts: [{ type: 'text', text }] };
}

async function emitted(name, requestBody) {
  const { default: scenario } = await import(`../fixtures/scenarios/${name}.mjs`);
  const turns = [];
  scenario.onPromptAsync({ emitTurn: (sessionID, turn) => turns.push(turn) }, 'ses_test', requestBody);
  return turns[0] ?? null;
}

test('every conclave scenario answers members, debate and judge with schema-valid output or an explicit failure', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const synthesis = buildSynthesisSchema(assets.schemas.synthesis, ['A', 'B']);
  for (const name of SCENARIOS.filter((n) => n !== 'conclave-review')) {
    for (const modelID of MODELS) {
      for (const [schema, text] of [[member, 'q'], [debate, '<peer_labels>A, C</peer_labels>']]) {
        const turn = await emitted(name, body(modelID, schema, text));
        if (turn === null) { assert.equal(name, 'conclave-member-timeout'); continue; }
        if (turn.error) { assert.equal(turn.error.name, 'StructuredOutputError'); continue; }
        assert.deepEqual(validateSchema(turn.structured, schema), [], `${name} ${modelID} ${schema.title}`);
      }
    }
    const judgeTurn = await emitted(name, body(MODELS[2], synthesis, '<labels>A, B</labels>'));
    if (judgeTurn.error) assert.equal(name, 'conclave-opinion');
    else assert.deepEqual(validateSchema(judgeTurn.structured, synthesis), [], `${name} judge`);
  }
});

test('debate scenario flips changed only for the deepseek member', async () => {
  const debate = buildDebateSchema(assets.schemas.member, ['A', 'C']);
  const changed = [];
  for (const modelID of MODELS) changed.push((await emitted('conclave-debate', body(modelID, debate, '<peer_labels>A, C</peer_labels>'))).structured.changed);
  assert.deepEqual(changed, [true, false, false]);
});

test('review scenario returns review-shaped output per family', async () => {
  const reviewSchema = structuredClone(assets.schemas.review);
  for (const modelID of MODELS) {
    const turn = await emitted('conclave-review', body(modelID, reviewSchema, 'diff'));
    assert.ok(['approve', 'needs-attention'].includes(turn.structured.verdict));
    assert.ok(Array.isArray(turn.structured.findings));
  }
});

test('self-identify scenario really names model, provider and vendor', async () => {
  const member = buildMemberSchema(assets.schemas.member);
  const turn = await emitted('conclave-self-identify', body(MODELS[1], member, 'q'));
  const text = JSON.stringify(turn.structured);
  assert.match(text, /qwen3\.8-max/);
  assert.match(text, /omniroute-personal/);
  assert.match(text, /Alibaba/);
});
