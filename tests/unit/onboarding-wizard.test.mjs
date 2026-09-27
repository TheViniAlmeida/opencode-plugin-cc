import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInitWizard } from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { createPrompter } from '../../plugins/opc/scripts/lib/tty.mjs';
import { scriptedTTY, captureStream } from '../helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog(load('provider.json'));
const agents = load('agent.json');
const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-wiz-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function wizard(t, answers, { existing = { global: null, workspace: null }, hasGlobal = false } = {}) {
  const dataDir = tmp(t);
  const ws = tmp(t);
  const output = captureStream();
  const log = captureStream();
  const prompter = createPrompter({ input: scriptedTTY(answers), output });
  t.after(() => prompter.close());
  const run = runInitWizard({ prompter, catalog, agents, existing, hasGlobal, dataDir, workspaceRoot: ws, log: (s) => log.write(s) });
  return { run, dataDir, output, log };
}

test('bootstrap wizard: invalid answer is re-asked, locked steps included, config committed', async (t) => {
  const answers = [
    '1',                 // provider
    'o', 'opencode/big-pickle', // "Outro": ambiguous -> error, step re-asked
    'kimi-k3', '1',      // model
    '1', '1',            // review / stop gate: none
    '1',                 // variant: none
    '1', '',             // models: no restriction; no provider deny
    '2', '',             // agents: only built-in; no deny
    '2',                 // approver: claude
    's', 'n',            // stop gate on, delegation off
    '', 'todos',         // no goal; all task types (no dirs: empty workspace)
    'n', 's',            // aliases: skip fast, create strong
    's',                 // save
  ];
  const { run, dataDir, log } = wizard(t, answers);
  const result = await run;
  assert.equal(result.scope, 'global');
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.defaultVariant, null);
  assert.deepEqual(cfg.policy.agents.allow, ['build', 'plan', 'general', 'explore']);
  assert.equal(cfg.policy.approver, 'claude');
  assert.equal(cfg.stopGate.enabled, true);
  assert.deepEqual(cfg.project, { goal: null, scope: [], taskTypes: ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'] });
  assert.deepEqual(cfg.aliases, { strong: `${MV}/opencode-go/qwen3.8-max` });
  assert.match(log.text(), /AMBIGUOUS|ambiguous/);
});

test('reconfigure wizard asks the scope first and may decline saving', async (t) => {
  const existing = { global: { defaultProvider: MV, defaultModel: `${MV}/opencode-go/kimi-k3` }, workspace: null };
  const answers = [
    '1',                 // scope: global
    '1',                 // provider
    'deepseek', '1',     // model
    '1', '1', '1',       // review, stop gate, variant
    '1', EQ,             // models: no restriction; deny omniroute-work
    '1', '',             // agents: all; no deny
    '1',                 // approver user
    'n', 'n',            // behaviour
    '', '',              // goal none; task types none
    'n', 'n',            // aliases
    'n',                 // do not save
  ];
  const { run, dataDir } = wizard(t, answers, { existing, hasGlobal: true });
  assert.equal(await run, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});
