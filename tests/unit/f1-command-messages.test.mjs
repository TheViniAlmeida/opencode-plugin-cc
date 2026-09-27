import test from 'node:test';
import assert from 'node:assert/strict';
import { run as runProviders } from '../../plugins/opc/scripts/commands/providers.mjs';
import { run as runModels } from '../../plugins/opc/scripts/commands/models.mjs';
import { run as runAgents } from '../../plugins/opc/scripts/commands/agents.mjs';
import { run as runCatalog } from '../../plugins/opc/scripts/commands/catalog.mjs';
import { run as runConfig } from '../../plugins/opc/scripts/commands/config.mjs';
import { run as runSetup } from '../../plugins/opc/scripts/commands/setup.mjs';

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
