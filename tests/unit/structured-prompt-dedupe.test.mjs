import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecomposePrompt, planSchema } from '../../plugins/opc/scripts/lib/orchestrator.mjs';
import { loadPrompt, loadSchema } from '../../plugins/opc/scripts/lib/prompts.mjs';
import { runTurn } from '../../plugins/opc/scripts/lib/runner.mjs';
import { jsonInstruction } from '../../plugins/opc/scripts/lib/structured-text.mjs';
import { memoryV2 } from './_memory-v2.mjs';

const INSTRUCTION = 'Reply with only one JSON object, no prose and no code fence';

async function sentPrompt(text, schema) {
  const { api, hub } = memoryV2();
  const pending = runTurn({ api, hub, request: { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text }], format: { type: 'json_schema', schema }, newSession: { title: 'OPC: t', permission: [{ action: '*', resource: '*', effect: 'deny' }] } } });
  await api.finishAll('{}');
  await pending;
  return api.promptCalls[0].text;
}

test('orchestrate planner prompt reaches the model with the JSON instruction only once', async () => {
  const schema = planSchema(loadSchema('orchestrate-plan'), 3);
  const prompt = buildDecomposePrompt({ template: loadPrompt('orchestrate-decompose'), task: 't', maxSubtasks: 3, write: false, schema });
  const sent = await sentPrompt(prompt, schema);
  assert.equal(sent, prompt);
  assert.equal(sent.split(INSTRUCTION).length - 1, 1);
});

test('runner still appends the JSON instruction when the prompt carries another schema', async () => {
  const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array' } } };
  const other = jsonInstruction({ type: 'object', required: ['other'] });
  const sent = await sentPrompt(`List files\n\n${other}`, schema);
  assert.equal(sent, `List files\n\n${other}\n\n${jsonInstruction(schema)}`);
});
