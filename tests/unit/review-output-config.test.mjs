import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfigShape, mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { run } from '../../plugins/opc/scripts/commands/config.mjs';
import { loadPrompt, loadSchema } from '../../plugins/opc/scripts/lib/prompts.mjs';
import { makeTempDir, trackTempDir, writeGlobalConfig } from '../helpers.mjs';

test('review structured output defaults to text and validates both modes', () => {
  assert.equal(DEFAULT_CONFIG.review?.structuredOutput, 'text');
  for (const value of ['text', 'tool']) assert.deepEqual(validateConfigShape({ review: { structuredOutput: value } }), { errors: [], warnings: [] });
  for (const value of ['json', null, 1, [], {}]) assert.equal(validateConfigShape({ review: { structuredOutput: value } }).errors.length, 1);
  assert.equal(validateConfigShape({ review: 'tool' }).errors.length, 1);
  assert.equal(mergeConfig({}, { review: { structuredOutput: 'tool' } }).config.review.structuredOutput, 'tool');
});

test('opc config gets, sets and unsets review.structuredOutput offline', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-review-config-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-review-workspace-'));
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, {});
  let view;
  const ctx = { dataDir, workspaceRoot, json: (v) => { view = v; }, out() {}, err() {} };
  const get = async () => { await run(ctx, ['get', 'review.structuredOutput', '--json']); return view.value; };
  assert.equal(await get(), 'text');
  await run(ctx, ['set', 'review.structuredOutput', 'tool', '--json']);
  assert.equal(await get(), 'tool');
  await assert.rejects(run(ctx, ['set', 'review.structuredOutput', 'invalid']), /text, tool/);
  await run(ctx, ['unset', 'review.structuredOutput', '--json']);
  assert.equal(await get(), 'text');
});

test('both review prompts require one JSON fence and describe every schema field and enum', () => {
  const schema = loadSchema('review-output');
  for (const name of ['review', 'adversarial-review']) {
    const prompt = loadPrompt(name);
    assert.match(prompt, /apenas.*objeto JSON.*única cerca ```json/);
    for (const key of [...schema.required, ...schema.properties.findings.items.required, ...schema.properties.verdict.enum, ...schema.properties.findings.items.properties.severity.enum]) assert.ok(prompt.includes(key), `${name}: ${key}`);
    assert.doesNotMatch(prompt, /Se a ferramenta StructuredOutput não estiver disponível/);
  }
});
