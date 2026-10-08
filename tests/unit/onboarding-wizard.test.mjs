import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDraftStep, buildDraft, runInitWizard } from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { createPrompter } from '../../plugins/opc/scripts/lib/tty.mjs';
import { scriptedTTY, captureStream, makeTempDir, trackTempDir } from '../helpers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog({ providers: load('provider.json'), models: load('model.json') });
const agents = load('agent.json').map((agent) => ({ ...agent, name: agent.id, native: ['build', 'plan', 'general', 'explore'].includes(agent.id) }));
const MV = 'omniroute-personal';
const EQ = 'omniroute-work';
const tmp = (t) => trackTempDir(t, makeTempDir('opc-wiz-'));

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
    's',                 // http em IP privado: sim
    's', 'n',            // stop gate on, delegation off
    '', 'todos',         // no goal; all task types (no dirs: empty workspace)
    'n', 's',            // aliases: skip fast, create strong
    's',                 // save
  ];
  const { run, dataDir, log, output } = wizard(t, answers);
  const result = await run;
  assert.equal(result.scope, 'global');
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.defaultVariant, null);
  assert.deepEqual(cfg.policy.agents.allow, ['build', 'plan', 'general', 'explore']);
  assert.equal(cfg.policy.approver, 'claude');
  assert.equal(cfg.server.allowPrivateHttp, true);
  assert.equal(cfg.stopGate.enabled, true);
  assert.deepEqual(cfg.project, { goal: null, scope: [], taskTypes: ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'] });
  assert.deepEqual(cfg.aliases, { strong: `${MV}/opencode-go/kimi-k3` });
  assert.match(log.text(), /AMBIGUOUS_MODEL: o modelo .* é ambíguo/);
  assert.doesNotMatch(output.text(), /Onde gravar\?/);
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
    'n',                 // http em IP privado: não
    'n', 'n',            // behaviour
    '', '',              // goal none; task types none
    'n', 'n',            // aliases
    'n',                 // do not save
  ];
  const { run, dataDir, output } = wizard(t, answers, { existing, hasGlobal: true });
  await run;
  for (const label of [
    'Só esta área de trabalho (.opc.json)', 'Provedor padrão?', 'variantes:',
    'Modelo da revisão?', 'Modelo da verificação de parada?', 'Variante padrão?',
    'Todos do provedor padrão', 'Provedores a negar (padrões separados por vírgula',
    'Só nativos', 'Agentes a negar (padrões separados por vírgula',
    'Ligar a verificação de parada (revisão ao parar)?', 'http:// (sem TLS) em IP privado',
    'Perguntar', 'Planejar', 'Revisar', 'Executar tarefa', 'Orquestrar', 'Conclave',
    'Criar apelido "fast"', 'Criar apelido "strong"', 'Gravar esta configuração?',
  ]) assert.ok(output.text().includes(label), `missing PT-BR label: ${label}`);
  assert.equal(await run, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});

test('wizard can select a model denied by the existing policy and allow it in the draft', async (t) => {
  const existing = { global: { defaultProvider: MV, policy: { models: { allow: ['unmatched/*'] } } }, workspace: null };
  const answers = [
    '1', '1', 'kimi-k3', '1', '1', '1', '1', 'o', `${MV}/*`, '',
    '1', '', '1', 'n', 'n', 'n', '', '', 'n', 'n', 's',
  ];
  const { run, dataDir, output, log } = wizard(t, answers, { existing, hasGlobal: true });
  const result = await run;
  assert.equal(result.scope, 'global');
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(cfg.policy.models.allow, [`${MV}/*`]);
  assert.match(output.text(), /kimi-k3/);
  assert.match(log.text(), /etapa de política precisa permitir este modelo/);
  assert.match(log.text(), /modelo negado pela política existente/);
  assert.doesNotMatch(log.text(), /commit will be refused until fixed|commit será recusado/);
});

test('onboarding validation errors are shown in Brazilian Portuguese', () => {
  const draft = buildDraft({ hasGlobal: false });
  assert.throws(() => applyDraftStep(draft, { defaultProvider: 'provider-not-connected' }, { catalog, agents }), {
    code: 'UNKNOWN_PROVIDER',
    message: /não está conectado/,
  });
});

test('wizard refuses commit when the new policy still denies the chosen model', async (t) => {
  const existing = { global: { defaultProvider: MV }, workspace: null };
  const answers = [
    '1', '1', 'kimi-k3', '1', '1', '1', '1', 'o', 'unmatched/*', '',
    '1', '', '1', 'n', 'n', 'n', '', '', 's',
  ];
  const { run } = wizard(t, answers, { existing, hasGlobal: true });
  await assert.rejects(run, { code: 'POLICY_DENIED' });
});

test('wizard without connected providers reports a Portuguese warning', async (t) => {
  const dir = tmp(t);
  await assert.rejects(runInitWizard({
    prompter: {}, catalog: buildCatalog({}), agents: [],
    existing: { global: null, workspace: null }, hasGlobal: false,
    dataDir: dir, workspaceRoot: dir,
  }), { code: 'NO_PROVIDER', message: 'nenhum provedor conectado disponível; execute: opencode auth login' });
});
