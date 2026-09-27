// Onboarding logic (spec §3.3): draft file + step validation + atomic commit.
// Pure with respect to the UI: the Claude flow (setup apply/commit) and the TTY wizard both drive it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError, PolicyError } from './opc-error.mjs';
import { writeFileAtomic, readJson, ensurePrivateDir } from './state.mjs';
import {
  CONFIG_SCHEMA, schemaFor, getPath, setPath, isLockedKey, isWorkspaceKey, validateConfigShape, mergeConfig,
  normalizeEditValue, validateAgainstServer, policyViolations, saveGlobalConfig, saveWorkspaceConfig, configPaths,
} from './config.mjs';
import { validateVariant } from './models.mjs';
import { evaluate } from './policy.mjs';

export const DRAFT_SCHEMA_VERSION = 1;

export const ONBOARDING_STEPS = Object.freeze([
  { id: 'scope', keys: ['scope'] },
  { id: 'defaultProvider', keys: ['defaultProvider'] },
  { id: 'defaultModel', keys: ['defaultModel'] },
  { id: 'reviewModels', keys: ['reviewModel', 'stopGate.model'] },
  { id: 'defaultVariant', keys: ['defaultVariant'] },
  { id: 'allowedModels', keys: ['policy.providers.allow', 'policy.providers.deny', 'policy.models.allow', 'policy.models.deny'], locked: true },
  { id: 'allowedAgents', keys: ['policy.agents.allow', 'policy.agents.deny'], locked: true },
  { id: 'approver', keys: ['policy.approver'], locked: true },
  { id: 'behaviour', keys: ['stopGate.enabled', 'delegation.auto'], globalOnly: true },
  { id: 'project', keys: ['project.goal', 'project.scope', 'project.taskTypes'] },
  { id: 'aliases', keys: ['aliases'] },
].map(Object.freeze));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function draftPath(dataDir) {
  return path.join(dataDir, 'config.draft.json');
}

export function buildDraft({ hasGlobal, now = new Date() }) {
  const stamp = now.toISOString();
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    mode: hasGlobal ? 'reconfigure' : 'bootstrap',
    scope: 'global',
    values: {},
    completed: hasGlobal ? [] : ['scope'],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function loadDraft(dataDir) {
  const draft = readJson(draftPath(dataDir), null);
  if (!isPlainObject(draft) || draft.schemaVersion !== DRAFT_SCHEMA_VERSION || !isPlainObject(draft.values)) return null;
  return draft;
}

export function saveDraft(dataDir, draft) {
  ensurePrivateDir(dataDir);
  writeFileAtomic(draftPath(dataDir), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

export function discardDraft(dataDir) {
  const file = draftPath(dataDir);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function stepApplies(step, draft, allowLocked) {
  if (step.id === 'scope') return draft.mode === 'reconfigure';
  if (step.locked) return allowLocked && draft.scope === 'global';
  if (step.globalOnly) return draft.scope === 'global';
  return true;
}

export function nextStep(draft, { allowLocked = false } = {}) {
  const step = ONBOARDING_STEPS.find((s) => stepApplies(s, draft, allowLocked) && !draft.completed.includes(s.id));
  return step ? step.id : null;
}

export function remainingSteps(draft, { allowLocked = false } = {}) {
  return ONBOARDING_STEPS.filter((s) => stepApplies(s, draft, allowLocked) && !draft.completed.includes(s.id)).map((s) => s.id);
}

function flattenPartial(partial) {
  if (!isPlainObject(partial)) throw new UsageError('INVALID_VALUE', 'onboarding payload must be a JSON object');
  const out = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (p === 'scope' || CONFIG_SCHEMA[p] || (prefix && schemaFor(p))) out.push([p, value]);
      else if (isPlainObject(value)) walk(value, p);
      else throw new UsageError('UNKNOWN_KEY', `unknown config key "${p}"`);
    }
  };
  walk(partial, '');
  return out;
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function lockedCommand(key, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return `opc config set ${key} ${shellQuote(rendered)} --tty-confirm`;
}

export function candidateConfig(draft, existing) {
  const base = (draft.scope === 'workspace' ? existing.workspace : existing.global) ?? {};
  return Object.entries(draft.values).reduce((cfg, [key, value]) => setPath(cfg, key, value), base);
}

function effectiveOf(draft, candidate, existing) {
  return draft.scope === 'workspace' ? mergeConfig(existing.global ?? {}, candidate) : mergeConfig(candidate, existing.workspace ?? {});
}

function effectiveValue(draft, existing, key) {
  return getPath(effectiveOf(draft, candidateConfig(draft, existing), existing).config, key);
}

export function applyDraftStep(draft, partial, { catalog, agents = [], existing = { global: null, workspace: null }, allowLocked = false, now = new Date() }) {
  const next = { ...draft, values: { ...draft.values }, completed: [...draft.completed] };
  const applied = [];
  const warnings = [];
  for (const [key, rawValue] of flattenPartial(partial)) {
    if (key === 'scope') {
      if (!['global', 'workspace'].includes(rawValue)) throw new UsageError('INVALID_VALUE', 'scope must be "global" or "workspace"');
      if (next.mode === 'bootstrap' && rawValue !== 'global') throw new UsageError('INVALID_VALUE', 'first setup must use the global scope (no global config yet)');
      next.scope = rawValue;
      applied.push('scope');
      continue;
    }
    if (isLockedKey(key) && !allowLocked) {
      const command = lockedCommand(key, rawValue);
      throw new PolicyError('LOCKED_KEY', `"${key}" is locked after the first setup; run in your own terminal: ${command}`, { details: { setting: key, command } });
    }
    if (next.scope === 'workspace' && !isWorkspaceKey(key)) {
      throw new UsageError('GLOBAL_ONLY_KEY', `"${key}" can only be set in the global config`);
    }
    const defaultProvider = key === 'defaultProvider' ? null : effectiveValue(next, existing, 'defaultProvider');
    let value;
    if (key === 'aliases') {
      if (!isPlainObject(rawValue)) throw new UsageError('INVALID_VALUE', 'aliases must map names to model IDs');
      const merged = { ...(getPath(candidateConfig(next, existing), 'aliases') ?? {}) };
      for (const [name, target] of Object.entries(rawValue)) {
        if (target === null) delete merged[name];
        else merged[name] = normalizeEditValue(`aliases.${name}`, target, { catalog, defaultProvider });
      }
      value = merged;
    } else {
      const shape = validateConfigShape(setPath({}, key, rawValue), { source: 'onboarding' });
      if (shape.errors.length) throw new UsageError('INVALID_VALUE', shape.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
      const aliases = effectiveValue(next, existing, 'aliases') ?? {};
      value = normalizeEditValue(key, rawValue, { catalog, aliases, defaultProvider });
    }
    if (key === 'defaultProvider' && value !== null && !catalog.connected.has(value)) {
      throw new UsageError('UNKNOWN_PROVIDER', `provider "${value}" is not connected (connected: ${[...catalog.connected].join(', ')})`);
    }
    if (key === 'defaultAgent' && value !== null) {
      const agent = agents.find((a) => a.name === value);
      if (!agent) throw new UsageError('UNKNOWN_AGENT', `agent "${value}" not found`);
    }
    if (key === 'defaultVariant' && value !== null) {
      const model = effectiveValue(next, existing, 'defaultModel');
      const entry = model ? catalog.byFull.get(model) : null;
      if (!entry) throw new UsageError('UNKNOWN_VARIANT', 'choose the default model before the variant');
      validateVariant(entry, value);
    }
    next.values[key] = value;
    applied.push(key);
  }
  const candidate = candidateConfig(next, existing);
  const effective = effectiveOf(next, candidate, existing).config;
  for (const violation of policyViolations(effective, { catalog, agents })) {
    const touched = applied.some((k) => violation.path === k || violation.path.startsWith(`${k}.`) || violation.path.startsWith(`${k}[`));
    if (touched) throw new PolicyError('POLICY_DENIED', `${violation.path}: ${violation.message}`, { details: violation });
    warnings.push({ path: violation.path, code: violation.code, message: `${violation.message} (commit will be refused until fixed)` });
  }
  for (const step of ONBOARDING_STEPS) {
    if (!next.completed.includes(step.id) && step.keys.some((k) => applied.includes(k))) next.completed.push(step.id);
  }
  next.updatedAt = now.toISOString();
  return { draft: next, applied, warnings, nextStep: nextStep(next, { allowLocked }) };
}

export function commitDraft({ dataDir, workspaceRoot, draft, catalog, agents = [], opencodeConfig = null, existing, allowLocked = false }) {
  const base = (draft.scope === 'workspace' ? existing.workspace : existing.global) ?? {};
  if (!allowLocked) {
    const changedLocked = Object.keys(draft.values).filter((k) => isLockedKey(k) && JSON.stringify(draft.values[k]) !== JSON.stringify(getPath(base, k)));
    if (changedLocked.length) {
      const commands = changedLocked.map((k) => lockedCommand(k, draft.values[k]));
      throw new PolicyError('LOCKED_KEY', `locked keys can no longer be changed from Claude (a global config now exists); run in your own terminal: ${commands.join(' ; ')}`,
        { details: { settings: changedLocked, commands } });
    }
  }
  const candidate = candidateConfig(draft, existing);
  const shape = validateConfigShape(candidate, { source: draft.scope });
  if (shape.errors.length) throw new UsageError('INVALID_CONFIG', 'draft config is invalid', { details: { errors: shape.errors } });
  const merged = effectiveOf(draft, candidate, existing);
  const server = validateAgainstServer(merged.config, { catalog, agents, opencodeConfig });
  if (server.errors.length) {
    throw new UsageError('INVALID_CONFIG', `draft config is invalid: ${server.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { details: { errors: server.errors } });
  }
  const denied = policyViolations(merged.config, { catalog, agents });
  if (denied.length) {
    throw new PolicyError('POLICY_DENIED', `draft config uses values denied by the policy: ${denied.map((e) => `${e.path} ${e.message}`).join('; ')}`, { details: { errors: denied } });
  }
  if (draft.scope === 'workspace') saveWorkspaceConfig(workspaceRoot, candidate);
  else saveGlobalConfig(dataDir, candidate);
  discardDraft(dataDir);
  const paths = configPaths({ dataDir, workspaceRoot });
  return {
    scope: draft.scope,
    path: draft.scope === 'workspace' ? paths.workspace : paths.global,
    config: candidate,
    effective: merged.config,
    warnings: [...shape.warnings, ...merged.warnings, ...server.warnings],
  };
}

export function rankProviders(catalog, policy) {
  return catalog.providers
    .filter((p) => p.connected)
    .map((p) => ({ id: p.id, name: p.name, modelCount: p.modelCount, ...evaluate('provider', p.id, policy) }))
    .sort((a, b) => b.modelCount - a.modelCount || a.id.localeCompare(b.id));
}

function allowedModels(catalog, providerID, policy) {
  return catalog.models.filter((m) => m.connected && m.providerID === providerID && evaluate('model', m.full, policy).allowed);
}

const byQuality = (a, b) => (Number(b.reasoning && b.toolcall) - Number(a.reasoning && a.toolcall))
  || String(b.releaseDate ?? '').localeCompare(String(a.releaseDate ?? ''))
  || a.full.localeCompare(b.full);

export function suggestModels(catalog, providerID, { top = 3, policy } = {}) {
  return allowedModels(catalog, providerID, policy)
    .filter((m) => m.status !== 'deprecated')
    .sort(byQuality)
    .slice(0, top);
}

export function suggestAliases(catalog, providerID, policy) {
  const pool = allowedModels(catalog, providerID, policy).filter((m) => m.status !== 'deprecated').sort(byQuality);
  const pick = (re) => pool.find((m) => re.test(m.modelID))?.full ?? null;
  return { fast: pick(/flash|mini|lite|haiku|fast/i), strong: pick(/max|pro|opus|k3|strong/i) };
}

export function modelFamilies(catalog, providerID) {
  const counts = new Map();
  for (const m of catalog.models.filter((x) => x.providerID === providerID)) {
    const family = m.modelID.includes('/') ? m.modelID.split('/')[0] : (m.family ?? m.modelID);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count, glob: `${providerID}/${family}${catalog.models.some((m) => m.providerID === providerID && m.modelID.startsWith(`${family}/`)) ? '/' : ''}*` }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

export function projectDirs(workspaceRoot, { limit = 30 } = {}) {
  const git = spawnSync('git', ['ls-files'], { cwd: workspaceRoot, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
  let dirs;
  if (git.status === 0) {
    dirs = [...new Set(git.stdout.split('\n').filter((f) => f.includes('/')).map((f) => `${f.split('/')[0]}/`))];
  } else {
    dirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => `${d.name}/`);
  }
  return dirs.sort().slice(0, limit);
}

export function onboardingSummary({ hasGlobal, draft, catalog, policy, opencode, npmAvailable, reconfigure = false, workspaceRoot = null, serverError = null }) {
  const allowLocked = draft ? draft.mode === 'bootstrap' && !hasGlobal : !hasGlobal;
  const providers = catalog ? rankProviders(catalog, policy) : [];
  return {
    needed: !hasGlobal || reconfigure,
    mode: hasGlobal ? 'reconfigure' : 'bootstrap',
    configExists: hasGlobal,
    opencodeInstalled: Boolean(opencode?.installed),
    opencodeVersion: opencode?.version ?? null,
    npmAvailable: Boolean(npmAvailable),
    serverError,
    connectedProviders: providers,
    providerChoices: providers.filter((p) => p.allowed).slice(0, 3).map((p) => p.id),
    needsOtherProvider: providers.filter((p) => p.allowed).length > 3,
    lockedKeysEditable: allowLocked,
    draft: draft ? { exists: true, mode: draft.mode, scope: draft.scope, completed: draft.completed, values: draft.values, updatedAt: draft.updatedAt } : { exists: false },
    nextStep: draft ? nextStep(draft, { allowLocked }) : (hasGlobal ? 'scope' : 'defaultProvider'),
    projectDirs: workspaceRoot ? projectDirs(workspaceRoot) : [],
    terminalWizard: 'opc config init',
  };
}

export function draftEffectiveConfig(draft, existing) {
  return effectiveOf(draft, candidateConfig(draft, existing), existing).config;
}
