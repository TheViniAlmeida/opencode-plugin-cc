import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { runTurn, newMessageId } from '../../plugins/opc/scripts/lib/runner.mjs';
import { makeCatalog, MEMBERS, answer, synthesis } from './_conclave-fixtures.mjs';
import { memoryV2 } from './_memory-v2.mjs';

// Drives every conclave turn through the real V2 runner, like commands/conclave.mjs does.
const assets = loadConclaveAssets();
const knownNames = buildKnownNames(makeCatalog());
const ECHO = { title: 'ConclaveMember', $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' };
const INSTRUCTION = 'Reply with only one JSON object, no prose and no code fence';

function realHarness(replyFor, { judge = { type: 'claude' } } = {}) {
  const turns = [];
  const turn = async (spec) => {
    const { api, hub } = memoryV2();
    const pending = runTurn({ api, hub, request: {
      newSession: { title: spec.title, permission: [{ action: '*', resource: '*', effect: 'deny' }] },
      parts: [{ type: 'text', text: spec.prompt }],
      model: { providerID: spec.member.providerID, modelID: spec.member.modelID },
      format: { type: 'json_schema', schema: spec.schema }, messageID: newMessageId(),
    } });
    await api.finishAll(replyFor(spec));
    const result = await pending;
    turns.push({ spec, result, prompt: api.promptCalls[0].text });
    return result;
  };
  const flags = { mode: 'opinion', rounds: 1, quorum: 2, members: MEMBERS, judge, maxParallel: 3, warnings: [] };
  return { turns, run: () => runConclave({ ctx: { config: { conclave: { structuredOutput: 'text' } } }, question: 'Q?', flags, deps: { assets, knownNames, turn, onEvent: () => {} } }) };
}

test('conclave accepts a member answer echoing schema keywords through the real V2 runner', async () => {
  const echoed = JSON.stringify({ ...ECHO, ...answer() });
  const h = realHarness((spec) => spec.label === 'A' ? echoed : JSON.stringify(answer()));
  const pkg = await h.run();
  const a = h.turns.find((t) => t.spec.label === 'A');
  assert.equal(a.result.status, 'completed');
  assert.equal(a.result.structured, null, 'the runner keeps strict schema validation');
  assert.equal(a.result.finalText, echoed);
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures, []);
  assert.deepEqual(pkg.final.responses.map((r) => r.label), ['A', 'B', 'C']);
  assert.deepEqual(pkg.final.responses.find((r) => r.label === 'A').response, answer());
});

test('conclave unwraps a schema-shaped wrapper through the real V2 runner', async () => {
  const wrapped = `\`\`\`json\n${JSON.stringify({ title: 'ConclaveMember', properties: answer() })}\n\`\`\``;
  const h = realHarness((spec) => spec.label === 'B' ? wrapped : JSON.stringify(answer()));
  const pkg = await h.run();
  assert.equal(h.turns.find((t) => t.spec.label === 'B').result.structured, null);
  assert.deepEqual(pkg.failures, []);
  assert.deepEqual(pkg.final.responses.find((r) => r.label === 'B').response, answer());
});

test('conclave judge recovers echoed schema keywords through the real V2 runner', async () => {
  const judge = { type: 'model', ...MEMBERS[2] };
  const h = realHarness((spec) => spec.role === 'judge'
    ? JSON.stringify({ ...ECHO, title: 'ConclaveSynthesis', ...synthesis(['A', 'B', 'C']) })
    : JSON.stringify(answer()), { judge });
  const pkg = await h.run();
  assert.equal(h.turns.find((t) => t.spec.role === 'judge').result.structured, null);
  assert.equal(pkg.judge.status, 'completed');
  assert.deepEqual(pkg.judge.synthesis, synthesis(['A', 'B', 'C']));
});

test('conclave still rejects an echoed answer with invalid values through the real V2 runner', async () => {
  const bad = JSON.stringify({ ...ECHO, ...answer({ confidence: 2 }) });
  const extra = JSON.stringify({ ...ECHO, ...answer(), surprise: true });
  const h = realHarness((spec) => spec.label === 'A' ? bad : spec.label === 'B' ? extra : JSON.stringify(answer()));
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.final.responses.map((r) => r.label), ['C']);
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.errorType]), [['A', 'InvalidStructuredOutput'], ['B', 'InvalidStructuredOutput']]);
  assert.match(pkg.failures[0].message, /\$\.confidence/);
  assert.equal(pkg.failures[0].rawText, bad);
  assert.equal(pkg.failures[1].rawText, extra);
});

test('conclave prose without JSON stays MissingStructuredOutput through the real V2 runner', async () => {
  const h = realHarness((spec) => spec.label === 'A' ? 'I would rather explain in prose.' : JSON.stringify(answer()));
  const pkg = await h.run();
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.errorType, f.rawText]), [['A', 'MissingStructuredOutput', 'I would rather explain in prose.']]);
});

test('conclave prompts reach the model with the JSON instruction only once', async () => {
  const h = realHarness(() => JSON.stringify(answer()));
  await h.run();
  assert.equal(h.turns.length, 3);
  for (const { prompt } of h.turns) assert.equal(prompt.split(INSTRUCTION).length - 1, 1);
});
