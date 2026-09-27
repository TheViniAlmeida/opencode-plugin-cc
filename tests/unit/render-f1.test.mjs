import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProviders, renderModels, renderAgents, renderCatalog, renderConfig, renderOnboarding } from '../../plugins/opc/scripts/lib/render.mjs';

const model = { full: 'omniroute-mvalmeida/opencode-go/kimi-k3', name: 'Kimi K3', variants: ['low', 'high'], limit: { context: 262144, output: 32768 }, cost: { input: 0.6, output: 2.5 }, status: 'active', allowed: true };

test('renderProviders: table with policy column and empty state', () => {
  const text = renderProviders({ providers: [{ id: 'omniroute-work', name: 'EQ', connected: true, modelCount: 3, defaultModel: null, allowed: false, rule: 'policy.providers.deny: omniroute-work' }], all: false });
  assert.match(text, /# Providers conectados/);
  assert.match(text, /negado \(policy\.providers\.deny: omniroute-work\)/);
  assert.match(renderProviders({ providers: [], all: false }), /opencode auth login/);
});

test('renderModels: compact and verbose', () => {
  const compact = renderModels({ models: [model], provider: null, verbose: false });
  assert.match(compact, /\| omniroute-mvalmeida\/opencode-go\/kimi-k3 \| Kimi K3 \| low, high \| permitido \|/);
  const verbose = renderModels({ models: [model], provider: 'omniroute-mvalmeida', verbose: true, allowedOnly: true });
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
});

test('renderConfig: redacts secret-looking values and renders all kinds', () => {
  const show = renderConfig({ kind: 'show', global: { server: { configOverride: { provider: { p: { options: { apiKey: 'sk-live-123' } } } } } }, workspace: null, paths: { global: '/d/config.json', workspace: '/w/.opc.json' }, warnings: [] });
  assert.ok(!show.includes('sk-live-123'));
  assert.match(show, /\*\*\*/);
  assert.match(show, /sem \.opc\.json/);
  assert.equal(renderConfig({ kind: 'get', setting: 'defaultModel', value: null }), 'defaultModel = null\n');
  assert.match(renderConfig({ kind: 'validate', errors: [{ source: 'global', path: 'defaultModel', code: 'UNKNOWN_MODEL', message: 'x' }], warnings: [], serverChecked: true }), /Config inválida/);
  assert.match(renderConfig({ kind: 'validate', errors: [], warnings: [], serverChecked: false, serverError: 'down' }), /não executada: down/);
  assert.match(renderConfig({ kind: 'path', dataDir: '/d', global: '/d/c', workspace: '/w/.opc.json', draft: '/d/config.draft.json' }), /Rascunho/);
  assert.throws(() => renderConfig({ kind: 'nope' }), TypeError);
});

test('renderOnboarding: state/apply/commit/discard', () => {
  const state = renderOnboarding({ kind: 'state', onboarding: { configExists: false, mode: 'bootstrap', opencodeInstalled: true, opencodeVersion: '1.18.32', connectedProviders: [{ id: 'p', modelCount: 2 }], draft: { exists: false }, nextStep: 'defaultProvider', lockedKeysEditable: true } });
  assert.match(state, /ainda não existe/);
  assert.match(renderOnboarding({ kind: 'apply', applied: ['defaultModel'], nextStep: null, warnings: [] }), /Próxima etapa: commit/);
  assert.match(renderOnboarding({ kind: 'commit', scope: 'global', path: '/d/config.json', warnings: [] }), /global/);
  assert.match(renderOnboarding({ kind: 'discard', discarded: false }), /Nenhum rascunho/);
});
