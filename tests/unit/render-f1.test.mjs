import test from 'node:test';
import assert from 'node:assert/strict';
import { renderError, renderProviders, renderModels, renderAgents, renderCatalog, renderConfig, renderOnboarding } from '../../plugins/opc/scripts/lib/render.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

const model = { full: 'omniroute-personal/opencode-go/kimi-k3', name: 'Kimi K3', variants: ['low', 'high'], limit: { context: 262144, output: 32768 }, cost: { input: 0.6, output: 2.5 }, status: 'active', allowed: true };

test('renderProviders: table with policy column and empty state', () => {
  const text = renderProviders({ providers: [{ id: 'omniroute-work', name: 'EQ', connected: true, modelCount: 3, defaultModel: null, allowed: false, rule: 'policy.providers.deny: omniroute-work' }], all: false });
  assert.match(text, /# Providers conectados/);
  assert.match(text, /negado \(policy\.providers\.deny: omniroute-work\)/);
  assert.match(renderProviders({ providers: [], all: false }), /opencode auth login/);
});

test('renderModels: compact and verbose', () => {
  const compact = renderModels({ models: [model], provider: null, verbose: false });
  assert.match(compact, /\| omniroute-personal\/opencode-go\/kimi-k3 \| Kimi K3 \| low, high \| permitido \|/);
  const verbose = renderModels({ models: [model], provider: 'omniroute-personal', verbose: true, allowedOnly: true });
  assert.match(verbose, /só permitidos/);
  assert.match(verbose, /262144/);
  assert.match(verbose, /0\.6 \/ 2\.5/);
  assert.match(renderModels({ models: [], verbose: false }), /Nenhum modelo/);
});

test('renderAgents / renderCatalog', () => {
  const a = renderAgents({ agents: [{ name: 'docs-writer', mode: 'subagent', description: 'Docs | PT-BR', native: false, hidden: false, pinnedModel: 'p/m', variant: 'high', allowed: true }], verbose: true, mode: 'subagent' });
  assert.match(a, /Docs \\\| PT-BR/, 'pipe escaped');
  assert.match(a, /\| p\/m \| high \|/);
  assert.match(renderCatalog({ kind: 'skills', items: [{ name: 'brainstorm', description: 'x', location: '/l' }] }), /# Skills/);
  assert.match(renderCatalog({ kind: 'commands', items: [{ name: 'docs', source: 'command', model: 'p/m', allowed: false, rule: 'r' }] }), /negado \(r\)/);
  const empty = renderAgents({ agents: [], warnings: ['atenção'] });
  assert.match(empty, /atenção/);
});

test('renderConfig: redacts secret-looking values and renders all kinds', () => {
  const show = renderConfig({ kind: 'show', global: { server: { configOverride: { provider: { p: { options: { apiKey: 'sk-live-123' } } } } } }, workspace: null, paths: { global: '/d/config.json', workspace: '/w/.opc.json' }, warnings: [] });
  assert.ok(!show.includes('sk-live-123'));
  assert.match(show, /\*\*\*/);
  assert.match(show, /sem \.opc\.json/);
  assert.equal(renderConfig({ kind: 'get', setting: 'defaultModel', value: null }), 'defaultModel = null\n');
  assert.equal(renderConfig({ kind: 'get', setting: 'server.apiKey', value: 'fake-secret-value' }), 'server.apiKey = "***"\n');
  assert.match(renderConfig({ kind: 'edit', setting: 'server.apiKey', value: 'fake-secret-value', op: 'set', scope: 'global', path: '/d/config.json' }), /Valor: `"\*\*\*"`/);
  for (const setting of ['key', 'server.key', 'provider.privateKey', 'x.api_key']) {
    assert.equal(renderConfig({ kind: 'get', setting, value: 'sensitive-value' }), `${setting} = "***"\n`, `${setting} get`);
    assert.match(renderConfig({ kind: 'edit', setting, value: 'sensitive-value', op: 'set', scope: 'global', path: '/d' }), /Valor: `"\*\*\*"`/, `${setting} edit`);
  }
  assert.equal(renderConfig({ kind: 'get', setting: 'defaultModel', value: 'public-model' }), 'defaultModel = "public-model"\n');
  assert.equal(renderConfig({ kind: 'get', setting: 'server.configOverride.keybinds', value: ['vim'] }), 'server.configOverride.keybinds = ["vim"]\n');
  const secret = 'registered-secret-warning-value';
  registerSecret(secret);
  const pathLeak = renderConfig({ kind: 'path', dataDir: `/data/${secret}`, global: '/d/config.json', workspace: '/w/.opc.json', draft: '/d/config.draft.json' });
  assert.ok(!pathLeak.includes(secret), 'config path output must redact registered secrets');
  const valueLeak = renderConfig({ kind: 'show', global: { defaultModel: secret }, workspace: null, paths: { global: '/d/config.json', workspace: '/w/.opc.json' }, warnings: [] });
  assert.ok(!valueLeak.includes(secret), 'config value output must redact registered secrets');
  assert.ok(!renderConfig({ kind: 'edit', setting: 'defaultModel', value: 'm', op: 'set', scope: 'global', path: '/d', warnings: [`warning ${secret}`] }).includes(secret));
  assert.ok(!renderConfig({ kind: 'validate', errors: [{ source: 'global', path: 'x', code: 'ERR', message: `error ${secret}` }], warnings: [], serverChecked: true }).includes(secret));
  assert.match(renderConfig({ kind: 'validate', errors: [{ source: 'global', path: 'defaultModel', code: 'UNKNOWN_MODEL', message: 'x' }], warnings: [], serverChecked: true }), /Config inválida/);
  assert.match(renderConfig({ kind: 'validate', errors: [], warnings: [], serverChecked: false, serverError: 'down' }), /não foi realizada: down/);
  const incomplete = renderConfig({ kind: 'validate', valid: false, errors: [], warnings: [], serverChecked: false, serverError: 'down' });
  assert.match(incomplete, /Config inválida|Config incompleta/);
  assert.doesNotMatch(incomplete, /Config válida/);
  assert.match(incomplete, /checagem contra o servidor não foi realizada|checagem contra o servidor não foi executada/i);
  assert.match(renderConfig({ kind: 'edit', setting: 'defaultModel', value: 'm', op: 'set', scope: 'global', path: '/d', warnings: [] }), /# opc config set/);
  assert.match(renderConfig({ kind: 'effective', config: { defaultModel: 'm' }, warnings: [] }), /# opc config efetiva/);
  assert.match(renderConfig({ kind: 'path', dataDir: '/d', global: '/d/c', workspace: '/w/.opc.json', draft: '/d/config.draft.json' }), /Rascunho/);
  assert.throws(() => renderConfig({ kind: 'nope' }), TypeError);
});

test('renderOnboarding: state/models/apply/commit/discard', () => {
  const state = renderOnboarding({ kind: 'state', onboarding: { configExists: false, mode: 'bootstrap', opencodeInstalled: true, opencodeVersion: '1.18.32', connectedProviders: [{ id: 'p', modelCount: 2 }], draft: { exists: false }, nextStep: 'defaultProvider', lockedKeysEditable: true } });
  assert.match(state, /ainda não existe/);
  assert.match(renderOnboarding({ kind: 'state', onboarding: { configExists: false, mode: 'bootstrap', opencodeInstalled: true, connectedProviders: null, draft: { exists: false }, lockedKeysEditable: true } }), /Providers conectados: não consultados/);
  assert.match(renderOnboarding({ kind: 'models', provider: 'p', suggestions: [model] }), /Sugestões de modelo/);
  assert.match(renderOnboarding({ kind: 'apply', applied: ['defaultModel'], nextStep: null, warnings: [] }), /Próxima etapa: commit/);
  assert.match(renderOnboarding({ kind: 'commit', scope: 'global', path: '/d/config.json', warnings: [] }), /global/);
  assert.match(renderOnboarding({ kind: 'discard', discarded: false }), /Nenhum rascunho/);
});


test('opc errors and config prose use registered redaction only', () => {
  const pattern = 'sk-' + 'proj-' + 'A'.repeat(24);
  assert.ok(renderError(new Error(pattern)).includes(pattern));
  assert.equal(renderConfig({ kind: 'get', setting: 'project.goal', value: pattern }), `project.goal = ${JSON.stringify(pattern)}\n`);
  const registered = 'registered-' + 'round-two-value';
  registerSecret(registered);
  assert.ok(!renderError(new Error(registered)).includes(registered));
  assert.ok(!renderConfig({ kind: 'get', setting: 'project.goal', value: registered }).includes(registered));
});
