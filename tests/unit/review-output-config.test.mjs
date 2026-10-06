import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfigShape, mergeConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { run } from '../../plugins/opc/scripts/commands/config.mjs';
import { loadPrompt, loadSchema } from '../../plugins/opc/scripts/lib/prompts.mjs';
import { makeTempDir, trackTempDir, writeGlobalConfig } from '../helpers.mjs';

test('review structured output defaults to text and migrates legacy tool mode', () => {
  assert.equal(DEFAULT_CONFIG.review?.structuredOutput, 'text');
  for (const value of ['text', 'tool']) assert.deepEqual(validateConfigShape({ review: { structuredOutput: value } }), { errors: [], warnings: [] });
  for (const value of ['json', null, 1, [], {}]) assert.equal(validateConfigShape({ review: { structuredOutput: value } }).errors.length, 1);
  assert.equal(validateConfigShape({ review: 'tool' }).errors.length, 1);
  const merged = mergeConfig({}, { review: { structuredOutput: 'tool' } });
  assert.equal(merged.config.review.structuredOutput, 'text');
  assert.equal(merged.warnings[0].code, 'STRUCTURED_OUTPUT_MIGRATED');
  assert.equal(merged.warnings[0].message, 'structuredOutput "tool" não existe no OpenCode V2; usando "text".');
});

test('opc config gets, sets and unsets review.structuredOutput offline', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-review-config-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-review-workspace-'));
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, {});
  let view;
  const ctx = { dataDir, workspaceRoot, json: (v) => { view = v; }, out() {}, err() {} };
  const get = async () => { await run(ctx, ['get', 'review.structuredOutput', '--json']); return view.value; };
  assert.equal(await get(), 'text');
  await run(ctx, ['set', 'review.structuredOutput', 'text', '--json']);
  assert.equal(await get(), 'text');
  await assert.rejects(run(ctx, ['set', 'review.structuredOutput', 'tool']), { code: 'INVALID_VALUE' });
  await assert.rejects(run(ctx, ['set', 'review.structuredOutput', 'invalid']), { code: 'INVALID_VALUE' });
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

test('I4: orchestrate structured output defaults to text and validates global/workspace modes', () => {
  assert.equal(DEFAULT_CONFIG.orchestrate.structuredOutput, 'text');
  for (const source of ['global', 'workspace']) {
    for (const value of ['text', 'tool']) assert.deepEqual(validateConfigShape({ orchestrate: { structuredOutput: value } }, { source }), { errors: [], warnings: [] });
    for (const value of ['json', null, 1, [], {}]) assert.equal(validateConfigShape({ orchestrate: { structuredOutput: value } }, { source }).errors.length, 1);
  }
  assert.equal(mergeConfig({ orchestrate: { structuredOutput: 'tool' } }, {}).config.orchestrate.structuredOutput, 'text');
  assert.equal(mergeConfig({ orchestrate: { structuredOutput: 'tool' } }, { orchestrate: { structuredOutput: 'text' } }).config.orchestrate.structuredOutput, 'text');
  assert.equal(mergeConfig({ orchestrate: { structuredOutput: 'tool' } }, { orchestrate: { structuredOutput: 'text' } }).warnings[0].code, 'STRUCTURED_OUTPUT_MIGRATED');
  assert.equal(mergeConfig({}, { orchestrate: { structuredOutput: 'tool' } }).config.orchestrate.structuredOutput, 'text');
});

test('I4: opc config edits orchestrate.structuredOutput offline', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-orch-config-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-orch-workspace-'));
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, {});
  let view;
  const ctx = { dataDir, workspaceRoot, json: (v) => { view = v; }, out() {}, err() {} };
  const get = async () => { await run(ctx, ['get', 'orchestrate.structuredOutput', '--json']); return view.value; };
  assert.equal(await get(), 'text');
  await run(ctx, ['set', 'orchestrate.structuredOutput', 'text', '--json']);
  assert.equal(await get(), 'text');
  await assert.rejects(run(ctx, ['set', 'orchestrate.structuredOutput', 'tool']), { code: 'INVALID_VALUE' });
  await assert.rejects(run(ctx, ['set', 'orchestrate.structuredOutput', 'invalid']), { code: 'INVALID_VALUE' });
  await run(ctx, ['unset', 'orchestrate.structuredOutput', '--json']);
  assert.equal(await get(), 'text');
});

test('conclave structured output defaults to text and validates both modes', () => {
  assert.equal(DEFAULT_CONFIG.conclave.structuredOutput, 'text');
  for (const value of ['text', 'tool']) assert.deepEqual(validateConfigShape({ conclave: { structuredOutput: value } }), { errors: [], warnings: [] });
  for (const value of ['json', null, 1, [], {}]) assert.equal(validateConfigShape({ conclave: { structuredOutput: value } }).errors.length, 1);
  assert.equal(mergeConfig({}, { conclave: { structuredOutput: 'tool' } }).config.conclave.structuredOutput, 'text');
});

test('opc config edits conclave.structuredOutput offline', async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-conclave-config-'));
  const workspaceRoot = trackTempDir(t, makeTempDir('opc-conclave-workspace-'));
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, {});
  let view;
  const ctx = { dataDir, workspaceRoot, json: (v) => { view = v; }, out() {}, err() {} };
  const get = async () => { await run(ctx, ['get', 'conclave.structuredOutput', '--json']); return view.value; };
  assert.equal(await get(), 'text');
  await run(ctx, ['set', 'conclave.structuredOutput', 'text', '--json']);
  assert.equal(await get(), 'text');
  await assert.rejects(run(ctx, ['set', 'conclave.structuredOutput', 'tool']), { code: 'INVALID_VALUE' });
  await assert.rejects(run(ctx, ['set', 'conclave.structuredOutput', 'invalid']), { code: 'INVALID_VALUE' });
  await run(ctx, ['unset', 'conclave.structuredOutput', '--json']);
  assert.equal(await get(), 'text');
});
