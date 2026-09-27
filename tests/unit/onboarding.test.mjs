import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ONBOARDING_STEPS, buildDraft, loadDraft, saveDraft, discardDraft, draftPath, nextStep, remainingSteps, applyDraftStep,
  commitDraft, lockedCommand, rankProviders, suggestModels, suggestAliases, modelFamilies, projectDirs, onboardingSummary,
} from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const catalog = buildCatalog(load('provider.json'));
const agents = load('agent.json');
const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const NOW = new Date('2026-09-26T12:00:00Z');
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-onb-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const NONE = { global: null, workspace: null };
const deps = (extra = {}) => ({ catalog, agents, existing: NONE, allowLocked: true, now: NOW, ...extra });

test('steps are the spec §3.3 list in order', () => {
  assert.deepEqual(ONBOARDING_STEPS.map((s) => s.id), ['scope', 'defaultProvider', 'defaultModel', 'reviewModels', 'defaultVariant', 'allowedModels', 'allowedAgents', 'approver', 'behaviour', 'project', 'aliases']);
});

test('buildDraft: bootstrap skips scope; reconfigure starts at scope', () => {
  const boot = buildDraft({ hasGlobal: false, now: NOW });
  assert.equal(boot.mode, 'bootstrap');
  assert.equal(nextStep(boot, { allowLocked: true }), 'defaultProvider');
  const re = buildDraft({ hasGlobal: true, now: NOW });
  assert.equal(re.mode, 'reconfigure');
  assert.equal(nextStep(re), 'scope');
  assert.ok(!remainingSteps(re).includes('allowedModels'), 'locked steps hidden without allowLocked');
  assert.ok(remainingSteps(re, { allowLocked: true }).includes('allowedModels'));
});

test('draft persistence: save (0600), load, discard; corrupt draft reads as null', (t) => {
  const dir = tmp(t);
  const d = buildDraft({ hasGlobal: false, now: NOW });
  saveDraft(dir, d);
  assert.equal(fs.statSync(draftPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(loadDraft(dir), d);
  assert.equal(discardDraft(dir), true);
  assert.equal(loadDraft(dir), null);
  assert.equal(discardDraft(dir), false);
  fs.writeFileSync(draftPath(dir), '{"schemaVersion":99}');
  assert.equal(loadDraft(dir), null);
});

test('applyDraftStep: provider, short model name normalized, variant validated', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV }, deps());
  let r = applyDraftStep(draft, { defaultModel: 'opencode-go/kimi-k3' }, deps());
  assert.equal(r.draft.values.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(r.nextStep, 'reviewModels');
  draft = r.draft;
  assert.throws(() => applyDraftStep(draft, { defaultVariant: 'ultra' }, deps()), (e) => e.code === 'UNKNOWN_VARIANT' && e.exitCode === 2);
  r = applyDraftStep(draft, { defaultVariant: 'high' }, deps());
  assert.equal(r.draft.values.defaultVariant, 'high');
  assert.ok(r.draft.completed.includes('defaultVariant'));
});

test('applyDraftStep: ambiguity, unknown provider, unknown key', () => {
  const { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV }, deps());
  assert.throws(() => applyDraftStep(draft, { defaultModel: 'opencode/big-pickle' }, deps()), (e) => e.code === 'AMBIGUOUS_MODEL');
  assert.throws(() => applyDraftStep(draft, { defaultProvider: 'openai' }, deps()), (e) => e.code === 'UNKNOWN_PROVIDER');
  assert.throws(() => applyDraftStep(draft, { nonsense: 1 }, deps()), (e) => e.code === 'UNKNOWN_KEY');
  assert.throws(() => applyDraftStep(draft, { scope: 'workspace' }, deps()), (e) => e.code === 'INVALID_VALUE');
  assert.throws(() => applyDraftStep(draft, 'x', deps()), (e) => e.code === 'INVALID_VALUE');
});

test('applyDraftStep: locked keys need allowLocked; error carries the terminal command', () => {
  const draft = buildDraft({ hasGlobal: true, now: NOW });
  assert.throws(() => applyDraftStep(draft, { policy: { models: { allow: [`${MV}/*`] } } }, deps({ allowLocked: false })), (e) => {
    assert.equal(e.code, 'LOCKED_KEY');
    assert.equal(e.exitCode, 4);
    assert.equal(e.details.command, `opc config set policy.models.allow '["omniroute-mvalmeida/*"]' --tty-confirm`);
    return true;
  });
});

test('applyDraftStep: policy applied in the same draft denies a new default (exit 4)', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { policy: { providers: { deny: [EQ] } } }, deps());
  assert.throws(() => applyDraftStep(draft, { defaultModel: `${EQ}/opencode-go/kimi-k3` }, deps()), (e) => e.code === 'POLICY_DENIED' && e.exitCode === 4);
  ({ draft } = applyDraftStep(draft, { defaultModel: `${MV}/opencode-go/kimi-k3` }, deps()));
  const r = applyDraftStep(draft, { policy: { models: { allow: ['anthropic/*'] } } }, deps());
  assert.equal(r.warnings[0].path, 'defaultModel', 'later policy step warns about earlier default');
});

test('applyDraftStep: aliases merge with the existing file and null removes', () => {
  const existing = { global: { defaultProvider: MV, aliases: { k3: `${MV}/opencode-go/kimi-k3`, pickle: 'opencode/big-pickle', old: `${MV}/opencode-go/qwen3.8-flash` } }, workspace: null };
  const draft = buildDraft({ hasGlobal: true, now: NOW });
  const r = applyDraftStep(draft, { aliases: { fast: 'opencode-go/deepseek-v4.1-flash', old: null } }, deps({ existing, allowLocked: false }));
  assert.deepEqual(r.draft.values.aliases, { k3: `${MV}/opencode-go/kimi-k3`, pickle: 'opencode/big-pickle', fast: `${MV}/opencode-go/deepseek-v4.1-flash` }, 'stored full ids are not re-normalized');
});

test('applyDraftStep: reviewModel accepts an alias defined earlier in the draft', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV, aliases: { strong: 'opencode-go/qwen3.8-max' } }, deps());
  ({ draft } = applyDraftStep(draft, { reviewModel: 'strong', stopGate: { model: null } }, deps()));
  assert.equal(draft.values.reviewModel, 'strong');
  assert.ok(draft.completed.includes('reviewModels'));
});

test('workspace scope: global-only keys refused', () => {
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: true, now: NOW }), { scope: 'workspace' }, deps({ allowLocked: false }));
  assert.equal(draft.scope, 'workspace');
  assert.throws(() => applyDraftStep(draft, { delegation: { auto: true } }, deps({ allowLocked: false })), (e) => e.code === 'GLOBAL_ONLY_KEY');
  assert.ok(!remainingSteps(draft).includes('behaviour'));
});

test('commitDraft: writes atomically, removes draft, returns effective config', (t) => {
  const dataDir = tmp(t);
  const ws = tmp(t);
  let { draft } = applyDraftStep(buildDraft({ hasGlobal: false, now: NOW }), { defaultProvider: MV, defaultModel: 'opencode-go/kimi-k3', policy: { providers: { deny: [EQ] }, agents: { deny: ['work-*'] } } }, deps());
  saveDraft(dataDir, draft);
  const r = commitDraft({ dataDir, workspaceRoot: ws, draft, catalog, agents, existing: NONE, allowLocked: true });
  assert.equal(r.path, path.join(dataDir, 'config.json'));
  const written = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(written.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(written.policy.providers.deny, [EQ]);
  assert.equal(r.effective.policy.approver, 'user');
  assert.equal(loadDraft(dataDir), null);
});

test('commitDraft: denied default refused (exit 4), nothing written, draft kept', (t) => {
  const dataDir = tmp(t);
  const draft = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { defaultModel: `${EQ}/opencode-go/kimi-k3`, 'policy.providers.deny': [EQ] } };
  saveDraft(dataDir, draft);
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft, catalog, agents, existing: NONE, allowLocked: true }), (e) => e.code === 'POLICY_DENIED' && e.exitCode === 4);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
  assert.ok(loadDraft(dataDir));
});

test('commitDraft: invalid model refused (exit 2); locked change refused without allowLocked', (t) => {
  const dataDir = tmp(t);
  const bad = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { defaultModel: `${MV}/opencode-go/removed` } };
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft: bad, catalog, agents, existing: NONE, allowLocked: true }), (e) => e.code === 'INVALID_CONFIG' && e.exitCode === 2);
  const lockedDraft = { ...buildDraft({ hasGlobal: false, now: NOW }), values: { 'policy.approver': 'claude' } };
  const existing = { global: { defaultProvider: MV }, workspace: null };
  assert.throws(() => commitDraft({ dataDir, workspaceRoot: dataDir, draft: lockedDraft, catalog, agents, existing, allowLocked: false }), (e) => {
    assert.equal(e.code, 'LOCKED_KEY');
    assert.deepEqual(e.details.commands, [`opc config set policy.approver 'claude' --tty-confirm`]);
    return true;
  });
});

test('lockedCommand quotes single quotes safely', () => {
  assert.equal(lockedCommand('project.goal', "it's"), `opc config set project.goal 'it'\\''s' --tty-confirm`);
});

test('rankProviders / suggestModels / suggestAliases / modelFamilies', () => {
  const policy = { providers: { deny: [EQ] }, models: { allow: [], deny: [] }, agents: {} };
  const ranked = rankProviders(catalog, policy);
  assert.deepEqual(ranked.map((p) => p.id), [MV, EQ, 'anthropic', 'opencode']);
  assert.equal(ranked.find((p) => p.id === EQ).allowed, false);
  const top = suggestModels(catalog, MV, { top: 3, policy });
  assert.equal(top.length, 3);
  assert.ok(top.every((m) => m.status !== 'deprecated'));
  assert.deepEqual(top.map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`, `${MV}/opencode-go/kimi-k3`]);
  assert.deepEqual(suggestAliases(catalog, MV, policy), { fast: `${MV}/opencode-go/qwen3.8-flash`, strong: `${MV}/opencode-go/qwen3.8-max` });
  assert.deepEqual(modelFamilies(catalog, MV)[0], { family: 'opencode-go', count: 5, glob: `${MV}/opencode-go/*` });
  assert.deepEqual(modelFamilies(catalog, 'opencode').map((f) => f.glob), ['opencode/big-pickle*', 'opencode/space-bunny*']);
});

test('projectDirs: non-git folder lists visible directories', (t) => {
  const ws = tmp(t);
  for (const d of ['src', 'tests', '.git-not', 'node_modules']) fs.mkdirSync(path.join(ws, d));
  assert.deepEqual(projectDirs(ws), ['src/', 'tests/']);
});

test('onboardingSummary: bootstrap without draft', () => {
  const s = onboardingSummary({ hasGlobal: false, draft: null, catalog, policy: {}, opencode: { installed: true, version: '1.18.32' }, npmAvailable: true });
  assert.equal(s.needed, true);
  assert.equal(s.mode, 'bootstrap');
  assert.equal(s.lockedKeysEditable, true);
  assert.equal(s.nextStep, 'defaultProvider');
  assert.deepEqual(s.providerChoices, [MV, EQ, 'anthropic']);
  assert.equal(s.needsOtherProvider, true);
  assert.equal(s.draft.exists, false);
});
