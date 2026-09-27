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
import { redact } from './redact.mjs';

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
  let draft;
  try {
    draft = readJson(draftPath(dataDir), null);
  } catch (error) {
    if (error.code === 'INVALID_JSON') return null;
    throw error;
  }
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
      else throw new UsageError('UNKNOWN_KEY', `chave de configuração desconhecida: "${p}"`);
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

export function applyDraftStep(draft, partial, { catalog, agents = [], existing = { global: null, workspace: null }, allowLocked = false, deferModelPolicy = false, now = new Date() }) {
  const next = { ...draft, values: { ...draft.values }, completed: [...draft.completed] };
  const applied = [];
  const warnings = [];
  for (const [key, rawValue] of flattenPartial(partial)) {
    if (key === 'scope') {
      if (!['global', 'workspace'].includes(rawValue)) throw new UsageError('INVALID_VALUE', 'scope must be "global" or "workspace"');
      if (next.mode === 'bootstrap' && rawValue !== 'global') throw new UsageError('INVALID_VALUE', 'a configuração inicial deve usar o escopo global (ainda não existe configuração global)');
      next.scope = rawValue;
      applied.push('scope');
      continue;
    }
    if (isLockedKey(key) && !allowLocked) {
      const command = lockedCommand(key, rawValue);
      throw new PolicyError('LOCKED_KEY', `"${key}" fica travada após a configuração inicial; execute no seu terminal: ${command}`, { details: { setting: key, command } });
    }
    if (next.scope === 'workspace' && !isWorkspaceKey(key)) {
      throw new UsageError('GLOBAL_ONLY_KEY', `"${key}" só pode ser definida na configuração global`);
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
      throw new UsageError('UNKNOWN_PROVIDER', `o provider "${value}" não está conectado (conectados: ${[...catalog.connected].join(', ')})`);
    }
    if (key === 'defaultAgent' && value !== null) {
      const agent = agents.find((a) => a.name === value);
      if (!agent) throw new UsageError('UNKNOWN_AGENT', `agent "${value}" not found`);
    }
    if (key === 'defaultVariant' && value !== null) {
      const model = effectiveValue(next, existing, 'defaultModel');
      const entry = model ? catalog.byFull.get(model) : null;
      if (!entry) throw new UsageError('UNKNOWN_VARIANT', 'escolha o modelo padrão antes da variante');
      validateVariant(entry, value);
    }
    next.values[key] = value;
    applied.push(key);
  }
  const candidate = candidateConfig(next, existing);
  const effective = effectiveOf(next, candidate, existing).config;
  for (const violation of policyViolations(effective, { catalog, agents })) {
    const touched = applied.some((k) => violation.path === k || violation.path.startsWith(`${k}.`) || violation.path.startsWith(`${k}[`));
    const deferredModel = deferModelPolicy && touched && ['defaultModel', 'reviewModel', 'stopGate.model'].some((key) => violation.path === key || violation.path.startsWith(`${key}.`));
    if (deferredModel) {
      warnings.push({ path: violation.path, code: violation.code, message: `${violation.message} (modelo negado pela política existente; a etapa de política precisa permitir este modelo)` });
      continue;
    }
    if (touched) throw new PolicyError('POLICY_DENIED', `${violation.path}: ${violation.message}`, { details: violation });
    warnings.push({ path: violation.path, code: violation.code, message: `${violation.message} (o salvamento será recusado até a correção)` });
  }
  for (const step of ONBOARDING_STEPS) {
    if (!next.completed.includes(step.id) && step.keys.some((k) => applied.includes(k))) next.completed.push(step.id);
  }
  next.updatedAt = now.toISOString();
  return { draft: next, applied, warnings, nextStep: nextStep(next, { allowLocked }) };
}

export function commitDraft({ dataDir, workspaceRoot, draft, catalog, agents = [], opencodeConfig = null, existing, allowLocked = false }) {
  if (draft.scope === 'workspace') {
    const disallowed = Object.keys(draft.values).filter((key) => !isWorkspaceKey(key));
    if (disallowed.length) {
      throw new UsageError('GLOBAL_ONLY_KEY', `Chaves não permitidas no escopo workspace: ${disallowed.join(', ')}`);
    }
  }
  const base = (draft.scope === 'workspace' ? existing.workspace : existing.global) ?? {};
  if (!allowLocked) {
    const changedLocked = Object.keys(draft.values).filter((k) => isLockedKey(k) && JSON.stringify(draft.values[k]) !== JSON.stringify(getPath(base, k)));
    if (changedLocked.length) {
      const commands = changedLocked.map((k) => lockedCommand(k, draft.values[k]));
      throw new PolicyError('LOCKED_KEY', `chaves travadas não podem mais ser alteradas pelo Claude (já existe uma configuração global); execute no seu terminal: ${commands.join(' ; ')}`,
        { details: { settings: changedLocked, commands } });
    }
  }
  const candidate = candidateConfig(draft, existing);
  const shape = validateConfigShape(candidate, { source: draft.scope });
  if (shape.errors.length) throw new UsageError('INVALID_CONFIG', 'a configuração em edição é inválida', { details: { errors: shape.errors } });
  const merged = effectiveOf(draft, candidate, existing);
  const server = validateAgainstServer(merged.config, { catalog, agents, opencodeConfig });
  if (server.errors.length) {
    throw new UsageError('INVALID_CONFIG', `a configuração em edição é inválida: ${server.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { details: { errors: server.errors } });
  }
  const denied = policyViolations(merged.config, { catalog, agents });
  if (denied.length) {
    throw new PolicyError('POLICY_DENIED', `a configuração em edição contém valores negados pela política: ${denied.map((e) => `${e.path} ${e.message}`).join('; ')}`, { details: { errors: denied } });
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

// ---- F1 Task 12: terminal wizard (the TTY is only an interface over the same steps) ----
const TASK_TYPE_CHOICES = ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'].map((t) => ({ label: t, value: t }));
const splitGlobs = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const modelChoice = (m) => ({ label: m.full, hint: `${m.name}${m.variants.length ? ` · variants: ${m.variants.join(', ')}` : ''}`, value: m.full });

async function askStep(prompter, stepId, { draft, catalog, agents, existing, workspaceRoot }) {
  const eff = draftEffectiveConfig(draft, existing);
  const provider = eff.defaultProvider;
  const allowedOf = (p) => suggestModels(catalog, p, { top: Infinity });
  const pickModel = async (question, { allowNone }) => {
    const choices = [...(allowNone ? [{ label: 'Nenhum (usar o modelo padrão)', value: null }] : []), ...(provider ? allowedOf(provider) : []).map(modelChoice)];
    const answer = await prompter.select(question, choices, { allowOther: true });
    return answer && typeof answer === 'object' ? answer.other : answer;
  };
  switch (stepId) {
    case 'scope':
      return { scope: await prompter.select('Onde gravar?', [{ label: 'Global (todas as pastas)', value: 'global' }, { label: 'Só este workspace (.opc.json)', value: 'workspace' }]) };
    case 'defaultProvider': {
      const ranked = rankProviders(catalog, eff.policy).filter((p) => p.allowed);
      if (!ranked.length) throw new UsageError('NO_PROVIDER', 'nenhum provider conectado disponível; execute: opencode auth login');
      return { defaultProvider: await prompter.select('Provider padrão?', ranked.map((p) => ({ label: p.id, hint: `${p.modelCount} modelos`, value: p.id }))) };
    }
    case 'defaultModel':
      return { defaultModel: await pickModel('Modelo padrão? (número, texto para filtrar ou "o" para digitar)', { allowNone: false }) };
    case 'reviewModels': {
      const reviewModel = await pickModel('Modelo do review?', { allowNone: true });
      const stopGateModel = await pickModel('Modelo do stop gate?', { allowNone: true });
      return { reviewModel, stopGate: { model: stopGateModel } };
    }
    case 'defaultVariant': {
      const entry = eff.defaultModel ? catalog.byFull.get(eff.defaultModel) : null;
      const variants = entry ? entry.variants : [];
      return { defaultVariant: await prompter.select('Variant padrão?', [{ label: 'Nenhuma', value: null }, ...variants.map((v) => ({ label: v, value: v }))]) };
    }
    case 'allowedModels': {
      const families = provider ? modelFamilies(catalog, provider).slice(0, 3) : [];
      const answer = await prompter.select('Modelos permitidos?', [
        { label: 'Sem restrição', value: [] },
        ...(provider ? [{ label: `Todos do provider padrão (${provider}/*)`, value: [`${provider}/*`] }] : []),
        ...families.map((f) => ({ label: `Só ${f.glob}`, hint: `${f.count} modelos`, value: [f.glob] })),
      ], { allowOther: true });
      const allow = Array.isArray(answer) ? answer : splitGlobs(answer.other);
      const denyProviders = splitGlobs(await prompter.text('Providers a negar (globs separados por vírgula; vazio = nenhum): ', { defaultValue: '' }));
      return { policy: { models: { allow }, providers: { deny: denyProviders } } };
    }
    case 'allowedAgents': {
      const builtIn = agents.filter((a) => a.native && !a.hidden).map((a) => a.name);
      const answer = await prompter.select('Agentes permitidos?', [
        { label: 'Todos', value: [] },
        { label: `Só built-in (${builtIn.join(', ')})`, value: builtIn },
      ], { allowOther: true });
      const allow = Array.isArray(answer) ? answer : splitGlobs(answer.other);
      const deny = splitGlobs(await prompter.text('Agentes a negar (globs separados por vírgula; vazio = nenhum): ', { defaultValue: '' }));
      return { policy: { agents: { allow, deny } } };
    }
    case 'approver':
      return { policy: { approver: await prompter.select('Quem aprova pedidos de permissão?', [{ label: 'Eu (usuário) — recomendado', value: 'user' }, { label: 'O Claude (exceto destrutivos, fora do diretório e caminhos sensíveis)', value: 'claude' }]) } };
    case 'behaviour':
      return {
        stopGate: { enabled: await prompter.confirm('Ligar o stop gate (review ao parar)?', { defaultValue: false }) },
        delegation: { auto: await prompter.confirm('Ligar a delegação automática?', { defaultValue: false }) },
      };
    case 'project': {
      const goal = await prompter.text('Objetivo do projeto (vazio = nenhum): ', { defaultValue: eff.project?.goal ?? '' });
      const dirs = projectDirs(workspaceRoot);
      const scope = dirs.length ? await prompter.multiSelect('Diretórios do escopo?', dirs.map((d) => ({ label: d, value: d }))) : [];
      const taskTypes = await prompter.multiSelect('Tipos de tarefa?', TASK_TYPE_CHOICES);
      return { project: { goal: goal === '' ? null : goal, scope, taskTypes } };
    }
    case 'aliases': {
      const suggested = provider ? suggestAliases(catalog, provider, eff.policy) : { fast: null, strong: null };
      const aliases = {};
      for (const name of ['fast', 'strong']) {
        if (suggested[name] && await prompter.confirm(`Criar alias "${name}" → ${suggested[name]}?`, { defaultValue: true })) aliases[name] = suggested[name];
      }
      return { aliases };
    }
    default:
      throw new UsageError('USAGE', `etapa desconhecida do assistente de configuração: ${stepId}`);
  }
}

export async function runInitWizard({ prompter, catalog, agents, opencodeConfig = null, existing, hasGlobal, dataDir, workspaceRoot, log = () => {} }) {
  let draft = buildDraft({ hasGlobal });
  const deps = { catalog, agents, existing, allowLocked: true };
  for (let step = nextStep(draft, { allowLocked: true }); step; step = nextStep(draft, { allowLocked: true })) {
    const partial = await askStep(prompter, step, { draft, catalog, agents, existing, workspaceRoot });
    try {
      const result = applyDraftStep(draft, partial, { ...deps, deferModelPolicy: ['defaultModel', 'reviewModels'].includes(step) });
      draft = result.draft;
      result.warnings.forEach((w) => log(`[opc] aviso: ${w.path}: ${w.message}\n`));
    } catch (err) {
      if (!(err.exitCode === 2 || err.exitCode === 4) || err.code === 'NO_PROVIDER') throw err;
      log(`[opc] ${err.message}\n`);
    }
  }
  log(`\n${JSON.stringify(redact(candidateConfig(draft, existing)), null, 2)}\n`);
  if (!(await prompter.confirm('Gravar esta config?', { defaultValue: true }))) return null;
  return commitDraft({ dataDir, workspaceRoot, draft, catalog, agents, opencodeConfig, existing, allowLocked: true });
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
