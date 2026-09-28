import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { run as runProviders } from '../../plugins/opc/scripts/commands/providers.mjs';
import { run as runModels } from '../../plugins/opc/scripts/commands/models.mjs';
import { run as runAgents } from '../../plugins/opc/scripts/commands/agents.mjs';
import { run as runCatalog } from '../../plugins/opc/scripts/commands/catalog.mjs';
import { run as runConfig } from '../../plugins/opc/scripts/commands/config.mjs';
import { run as runSetup } from '../../plugins/opc/scripts/commands/setup.mjs';
import { reviewGateChange } from '../../plugins/opc/scripts/commands/setup.mjs';

const invalidCommands = [
  ['providers', () => runProviders({}, ['unexpected'])],
  ['models', () => runModels({}, ['one', 'two'])],
  ['agents usage', () => runAgents({}, ['unexpected'])],
  ['agents mode', () => runAgents({}, ['--mode', 'invalid'])],
  ['catalog', () => runCatalog({}, ['unknown'])],
  ['config', () => runConfig({}, ['unknown'])],
  ['setup', () => runSetup({}, ['--force'])],
];

test('F1 command usage errors keep codes and use Brazilian Portuguese', async () => {
  for (const [name, invoke] of invalidCommands) {
    await assert.rejects(invoke, (err) => {
      assert.equal(err.code, 'USAGE', name);
      assert.match(err.message, /uso:|deve ser um de|só valem junto/, name);
      assert.doesNotMatch(err.message, /usage:|must be/, name);
      return true;
    });
  }
});

test('setup apply errors redact malformed JSON and reject simultaneous stdin and positional input', async () => {
  const secret = 'FAKE_SECRET_DO_NOT_ECHO';
  await assert.rejects(
    runSetup({ stdin: Readable.from([`{"token":"${secret}",`]) }, ['apply', '--stdin']),
    (err) => {
      assert.equal(err.code, 'INVALID_JSON');
      assert.match(err.message, /JSON.*válido/i);
      assert.doesNotMatch(err.message, new RegExp(secret));
      return true;
    },
  );
  await assert.rejects(
    runSetup({ stdin: Readable.from(['{}']) }, ['apply', '--stdin', '{"value":"ignored"}']),
    (err) => {
      assert.equal(err.code, 'USAGE');
      assert.match(err.message, /uso:/i);
      assert.doesNotMatch(err.message, /ignored/);
      return true;
    },
  );
});

test('setup review-gate flags map to config changes and reject simultaneous use', () => {
  assert.equal(reviewGateChange({ 'enable-review-gate': true }), true);
  assert.equal(reviewGateChange({ 'disable-review-gate': true }), false);
  assert.throws(() => reviewGateChange({ 'enable-review-gate': true, 'disable-review-gate': true }), (err) => err.code === 'USAGE');
});
