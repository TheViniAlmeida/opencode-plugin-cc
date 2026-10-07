// Global config + workspace override with the restrictive merge of spec §3.2 (F0 base; F1 completes).
import { isSecretLikeSetting } from './secret-settings.mjs';
export { isSecretLikeSetting } from './secret-settings.mjs';
import fs from 'node:fs';
import path, { join as joinPathF1 } from 'node:path';
import { OpcError, UsageError } from './opc-error.mjs';
import { readJson, writeFileAtomic } from './state.mjs';
import { matchesAny, resolveModelRef, normalizeModelId, validateVariant } from './models.mjs';
import { evaluate, evaluateAgent } from './policy.mjs';
import { withLock } from './locks.mjs';

// ---- F1: complete schema, restrictive merge, locked keys, edits and server validation (spec §3.2, §3.3) ----
export const LOCKED_KEYS = Object.freeze(['policy', 'permissionProfiles', 'server.configOverride', 'server.opencodeBin']);
const MISSING = Symbol('missing');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (!isObj(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const [head, ...rest] = String(dotted).split('.');
  const base = isObj(obj) ? obj : {};
  if (rest.length === 0) return { ...base, [head]: value };
  return { ...base, [head]: setPath(base[head], rest.join('.'), value) };
}

export function matchesGlob(value, glob) {
  const escaped = String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(String(value));
}

const freezeDeep = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && freezeDeep(v)); return Object.freeze(o); };

export const DEFAULT_CONFIG = freezeDeep({
  defaultProvider: null,
  defaultModel: null,
  defaultVariant: null,
  defaultAgent: null,
  aliases: {},
  reviewModel: null,
  review: { structuredOutput: 'text' },
  stopGate: { enabled: false, model: null },
  project: { goal: null, scope: [], taskTypes: [] },
  policy: {
    providers: { allow: [], deny: [] },
    models: { allow: [], deny: [] },
    agents: { allow: [], deny: [] },
    tools: { deny: [] },
    sensitivePaths: ['*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets.env'],
    destructiveBash: [],
    approver: 'user',
    permissionTimeoutSec: 600,
  },
  permissionProfiles: {},
  routing: { tasks: {}, tiers: {}, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } },
  conclave: { pools: {}, defaultPool: null, judge: 'claude', rounds: 1, quorum: 2, memberTimeoutSec: 900, structuredOutput: 'text' },
  orchestrate: { planner: null, maxSubtasks: 5, synthesizer: 'claude', structuredOutput: 'text' },
  delegation: { auto: false },
  jobs: { maxActive: 8, maxParallel: 4 },
  server: { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } },
});

const schemaField = (type, extra = {}) => Object.freeze({ type, ...extra });
const TASK_TYPES = ['ask', 'plan', 'review', 'task', 'orchestrate', 'conclave'];

export const CONFIG_SCHEMA = Object.freeze({
  defaultProvider: schemaField('string', { nullable: true }),
  defaultModel: schemaField('model', { nullable: true }),
  defaultVariant: schemaField('string', { nullable: true }),
  defaultAgent: schemaField('string', { nullable: true }),
  aliases: schemaField('model-map'),
  reviewModel: schemaField('modelref', { nullable: true }),
  'review.structuredOutput': schemaField('enum', { values: ['text'] }),
  'stopGate.enabled': schemaField('boolean'),
  'stopGate.model': schemaField('modelref', { nullable: true }),
  'project.goal': schemaField('string', { nullable: true }),
  'project.scope': schemaField('string-list'),
  'project.taskTypes': schemaField('enum-list', { values: TASK_TYPES }),
  'policy.providers.allow': schemaField('string-list'),
  'policy.providers.deny': schemaField('string-list'),
  'policy.providers.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.models.allow': schemaField('string-list'),
  'policy.models.deny': schemaField('string-list'),
  'policy.models.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.agents.allow': schemaField('string-list'),
  'policy.agents.deny': schemaField('string-list'),
  'policy.agents.allowWorkspace': schemaField('string-list', { internal: true }),
  'policy.tools.deny': schemaField('string-list'),
  'policy.sensitivePaths': schemaField('string-list'),
  'policy.destructiveBash': schemaField('string-list'),
  'policy.approver': schemaField('enum', { values: ['user', 'claude'] }),
  'policy.permissionTimeoutSec': schemaField('integer', { min: 1, max: 86400 }),
  permissionProfiles: schemaField('rules-map'),
  'routing.tasks': schemaField('modelref-list-map'),
  'routing.tiers': schemaField('modelref-list-map'),
  'routing.fallback.enabled': schemaField('boolean'),
  'routing.fallback.maxAttempts': schemaField('integer', { min: 1, max: 10 }),
  'routing.fallback.maxProviderRetries': schemaField('integer', { min: 0, max: 20 }),
  'routing.fallback.maxRetryWaitSec': schemaField('integer', { min: 0, max: 3600 }),
  'conclave.pools': schemaField('modelref-list-map'),
  'conclave.defaultPool': schemaField('string', { nullable: true }),
  'conclave.judge': schemaField('modelref-or-claude'),
  'conclave.rounds': schemaField('integer', { min: 1, max: 3 }),
  'conclave.quorum': schemaField('integer', { min: 2, max: 16 }),
  'conclave.memberTimeoutSec': schemaField('integer', { min: 1, max: 86400 }),
  'conclave.structuredOutput': schemaField('enum', { values: ['text'] }),
  'orchestrate.structuredOutput': schemaField('enum', { values: ['text'] }),
  'orchestrate.planner': schemaField('modelref', { nullable: true }),
  'orchestrate.maxSubtasks': schemaField('integer', { min: 2, max: 20 }),
  'orchestrate.synthesizer': schemaField('modelref-or-claude'),
  'delegation.auto': schemaField('boolean'),
  'jobs.maxActive': schemaField('integer', { min: 1, max: 64 }),
  'jobs.maxParallel': schemaField('integer', { min: 1, max: 32 }),
  'server.bootTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.requestTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.opencodeBin': schemaField('string'),
  'server.configOverride': schemaField('object'),
});

const MAP_ENTRY = Object.freeze({ 'model-map': schemaField('model'), 'modelref-list-map': schemaField('modelref-list'), 'rules-map': schemaField('rules'), object: schemaField('json') });
const GROUPS = new Set(Object.keys(CONFIG_SCHEMA).flatMap((k) => k.split('.').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('.'))));
const WORKSPACE_PREFERENCE_KEYS = ['defaultProvider', 'defaultModel', 'defaultVariant', 'defaultAgent', 'aliases', 'reviewModel', 'review', 'stopGate.model', 'project', 'routing', 'conclave', 'orchestrate'];
const WORKSPACE_POLICY_LISTS = ['policy.providers.allow', 'policy.providers.deny', 'policy.models.allow', 'policy.models.deny', 'policy.agents.allow', 'policy.agents.deny', 'policy.tools.deny', 'policy.sensitivePaths', 'policy.destructiveBash'];
const MODEL_TYPES = new Set(['model', 'modelref', 'modelref-or-claude', 'model-map', 'modelref-list-map', 'modelref-list']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STRUCTURED_OUTPUT_KEYS = ['review.structuredOutput', 'conclave.structuredOutput', 'orchestrate.structuredOutput'];
const STRUCTURED_OUTPUT_WARNING = 'structuredOutput "tool" não existe no OpenCode V2; usando "text".';

export function schemaFor(dotted) {
  if (Object.hasOwn(CONFIG_SCHEMA, dotted)) return CONFIG_SCHEMA[dotted];
  const parts = dotted.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const parentPath = parts.slice(0, i).join('.');
    const parent = Object.hasOwn(CONFIG_SCHEMA, parentPath) ? CONFIG_SCHEMA[parentPath] : null;
    if (parent && MAP_ENTRY[parent.type]) return parent.type === 'object' ? MAP_ENTRY.object : (i === parts.length - 1 ? MAP_ENTRY[parent.type] : null);
  }
  return null;
}

export function isLockedKey(dotted) {
  return LOCKED_KEYS.some((k) => dotted === k || dotted.startsWith(`${k}.`) || k.startsWith(`${dotted}.`));
}

export function isWorkspaceKey(dotted) {
  if (WORKSPACE_POLICY_LISTS.includes(dotted)) return true;
  return WORKSPACE_PREFERENCE_KEYS.some((k) => dotted === k || dotted.startsWith(`${k}.`));
}

export function keyNeedsServer(dotted) {
  const desc = schemaFor(dotted);
  return Boolean(desc && MODEL_TYPES.has(desc.type)) || ['defaultProvider', 'defaultAgent', 'defaultVariant'].includes(dotted);
}

function checkValue(desc, value) {
  if (value === null) return desc.nullable ? null : 'não pode ser nulo';
  switch (desc.type) {
    case 'string': case 'model': case 'modelref': case 'modelref-or-claude':
      return typeof value === 'string' && value.trim() !== '' ? null : 'deve ser um texto não vazio';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'deve ser verdadeiro ou falso';
    case 'integer':
      if (!Number.isInteger(value)) return 'deve ser um número inteiro';
      if (value < desc.min || value > desc.max) return `deve estar entre ${desc.min} e ${desc.max}`;
      return null;
    case 'enum':
      return desc.values.includes(value) ? null : `deve ser um destes valores: ${desc.values.join(', ')}`;
    case 'string-list': case 'modelref-list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'deve ser uma lista de textos não vazios';
    case 'enum-list':
      if (!Array.isArray(value)) return 'deve ser uma lista';
      return value.every((v) => desc.values.includes(v)) ? null : `os itens devem estar entre: ${desc.values.join(', ')}`;
    case 'model-map':
      return isObj(value) && Object.values(value).every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'deve associar nomes a IDs de modelo';
    case 'modelref-list-map':
      return isObj(value) && Object.values(value).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')) ? null : 'deve associar nomes a listas de modelos';
    case 'rules': return checkRules(value);
    case 'rules-map':
      if (!isObj(value)) return 'deve associar nomes de perfis a listas de regras';
      for (const rules of Object.values(value)) { const e = checkRules(rules); if (e) return e; }
      return null;
    case 'object': return isObj(value) ? null : 'deve ser um objeto';
    case 'json': return null;
    default: return `tipo de esquema desconhecido: ${desc.type}`;
  }
}

function checkRules(rules) {
  if (!Array.isArray(rules)) return 'as regras devem ser uma lista';
  const ok = rules.every((r) => isObj(r) && typeof r.action === 'string' && typeof r.resource === 'string' && ['allow', 'deny', 'ask'].includes(r.effect));
  return ok ? null : 'cada regra precisa de {action, resource, effect: allow|deny|ask}';
}

export function findSecretLikeKeys(obj, prefix = '') {
  const hits = [];
  if (!isObj(obj) && !Array.isArray(obj)) return hits;
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!Array.isArray(obj) && isSecretLikeSetting(p)) hits.push(p);
    hits.push(...findSecretLikeKeys(value, p));
  }
  return hits;
}


export function validateConfigShape(obj, { source = 'global' } = {}) {
  const errors = [];
  const warnings = [];
  if (obj === null || obj === undefined) return { errors, warnings };
  if (!isObj(obj)) return { errors: [{ path: '', code: 'INVALID_VALUE', message: `a configuração ${source} deve ser um objeto JSON` }], warnings };
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      const desc = CONFIG_SCHEMA[p];
      if (desc) {
        if (STRUCTURED_OUTPUT_KEYS.includes(p) && value === 'tool') continue;
        const problem = checkValue(desc, value);
        if (problem) errors.push({ path: p, code: 'INVALID_VALUE', message: problem });
      } else if (GROUPS.has(p)) {
        if (isObj(value)) walk(value, p);
        else errors.push({ path: p, code: 'INVALID_VALUE', message: 'deve ser um objeto' });
      } else {
        warnings.push({ path: p, code: 'UNKNOWN_KEY', message: `chave desconhecida (ignorada) na configuração ${source}` });
      }
    }
  };
  walk(obj, '');
  if (source === 'workspace') {
    for (const key of LOCKED_KEYS) {
      if (getPath(obj, key) !== undefined) warnings.push({ path: key, code: 'UNKNOWN_KEY', message: 'chave travada (somente global)' });
    }
  }
  for (const p of findSecretLikeKeys(obj)) {
    warnings.push({ path: p, code: 'SECRET_LIKE_KEY', message: 'a chave parece ser um segredo; arquivos de configuração não devem conter segredos (use variáveis de ambiente ou o cofre)' });
  }
  return { errors, warnings };
}

function mergeDeep(base, over) {
  if (!isObj(base) || !isObj(over)) return cloneJson(over);
  const out = cloneJson(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : cloneJson(v);
  return out;
}

const unionList = (a = [], b = []) => [...new Set([...(a ?? []), ...(b ?? [])])];

function unsetConfigPath(obj, dotted) {
  const [head, ...rest] = dotted.split('.');
  if (!isObj(obj) || !Object.hasOwn(obj, head)) return obj;
  const out = { ...obj };
  if (rest.length === 0) delete out[head];
  else out[head] = unsetConfigPath(out[head], rest.join('.'));
  return out;
}

export function mergeConfig(globalCfg, workspaceCfg) {
  const warnings = [];
  const config = mergeDeep(cloneJson(DEFAULT_CONFIG), isObj(globalCfg) ? globalCfg : {});
  let ws = isObj(workspaceCfg) ? cloneJson(workspaceCfg) : {};
  const { errors: wsErrors } = validateConfigShape(ws, { source: 'workspace' });
  for (const error of wsErrors) {
    warnings.push({ path: error.path, code: 'WORKSPACE_IGNORED', message: `.opc.json: ${error.message}; ignorado` });
    if (error.path) ws = unsetConfigPath(ws, error.path);
  }
  const ignore = (p, why) => warnings.push({ path: p, code: 'WORKSPACE_IGNORED', message: `.opc.json: ${why}; ignorado` });
  ws = dropUnknownConfigKeys(ws, '', (p) => ignore(p, 'chave desconhecida'));
  for (const [key, value] of Object.entries(ws)) {
    if (key === 'policy') {
      if (!isObj(value)) { ignore('policy', 'deve ser um objeto'); continue; }
      mergeWorkspacePolicy(config, value, ignore, warnings);
    } else if (key === 'stopGate' && isObj(value)) {
      for (const [sub, v] of Object.entries(value)) {
        if (sub === 'model') config.stopGate.model = cloneJson(v);
        else ignore(`stopGate.${sub}`, 'não pode ser substituído no workspace');
      }
    } else if (WORKSPACE_PREFERENCE_KEYS.includes(key)) {
      // A cleared workspace defaultModel inherits the global model, like unset.
      if (key === 'defaultModel' && value === null) continue;
      config[key] = isObj(value) && isObj(config[key]) ? mergeDeep(config[key], value) : cloneJson(value);
    } else if (isLockedKey(key) || key === 'server') {
      ignore(key, 'chave travada (somente global)');
      if (key === 'server' && isObj(value) && Object.hasOwn(value, 'configOverride')) ignore('server.configOverride', 'chave travada (somente global)');
    } else if (key in DEFAULT_CONFIG) {
      ignore(key, 'não pode ser substituída no workspace');
    } else {
      ignore(key, 'chave desconhecida');
    }
  }
  for (const key of STRUCTURED_OUTPUT_KEYS) {
    if (getPath(globalCfg, key) === 'tool' || getPath(workspaceCfg, key) === 'tool') {
      warnings.push({ path: key, code: 'STRUCTURED_OUTPUT_MIGRATED', message: STRUCTURED_OUTPUT_WARNING,
        source: getPath(workspaceCfg, key) === 'tool' ? 'workspace' : 'global' });
    }
    if (getPath(config, key) === 'tool') {
      const [group] = key.split('.');
      config[group].structuredOutput = 'text';
    }
  }
  return { config, warnings };
}

function dropUnknownConfigKeys(node, prefix, onUnknown) {
  if (!isObj(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const exact = Object.hasOwn(CONFIG_SCHEMA, p);
    const desc = exact ? CONFIG_SCHEMA[p] : schemaFor(p);
    if (!desc && !GROUPS.has(p)) { onUnknown(p); continue; }
    if (exact && ['object', 'json'].includes(desc.type)) out[key] = cloneJson(value);
    else if (GROUPS.has(p) && isObj(value)) out[key] = dropUnknownConfigKeys(value, p, onUnknown);
    else out[key] = cloneJson(value);
  }
  return out;
}

function mergeWorkspacePolicy(config, wsPolicy, ignore, warnings) {
  for (const [sub, value] of Object.entries(wsPolicy)) {
    const p = `policy.${sub}`;
    if (['providers', 'models', 'agents', 'tools'].includes(sub) && isObj(value)) {
      for (const [listName, list] of Object.entries(value)) {
        const lp = `${p}.${listName}`;
        if (!Array.isArray(list)) { ignore(lp, 'deve ser uma lista'); continue; }
        if (listName === 'deny') {
          config.policy[sub].deny = unionList(config.policy[sub].deny, list);
        } else if (listName === 'allow' && sub !== 'tools') {
          if (list.length === 0) continue;
          const globalAllow = config.policy[sub].allow;
          if (globalAllow.length > 0) {
            for (const entry of list) {
              if (!matchesAny(entry, globalAllow)) warnings.push({ path: lp, code: 'WORKSPACE_ALLOW_NARROWED', message: `.opc.json: "${entry}" está fora da lista global de permissões; somente a interseção se aplica` });
            }
          }
          config.policy[sub].allowWorkspace = [...list];
        } else {
          ignore(lp, 'somente listas allow/deny podem ser definidas no workspace');
        }
      }
    } else if ((sub === 'sensitivePaths' || sub === 'destructiveBash') && Array.isArray(value)) {
      config.policy[sub] = unionList(config.policy[sub], value);
    } else {
      ignore(p, 'chave travada (somente global)');
    }
  }
}
// ---- end F1 (part A) ----

export function globalConfigPath(dataDir) {
  return path.join(dataDir, 'config.json');
}

export function workspaceConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, '.opc.json');
}

export function loadConfig({ dataDir, workspaceRoot }) {
  const warnings = [];
  const gPath = globalConfigPath(dataDir);
  let global = MISSING;
  try {
    global = readJson(gPath, MISSING);
  } catch (err) {
    if (err.code === 'INVALID_JSON') throw new OpcError('CONFIG_INVALID', `A config global ${gPath} não é um JSON válido.`, { exitCode: 2, details: { path: gPath }, cause: err });
    throw err;
  }
  if (global !== MISSING) {
    if (!isPlainObject(global)) {
      throw new OpcError('CONFIG_INVALID', `Config global inválida: precisa conter um objeto JSON.`, {
        exitCode: 2,
        details: { path: gPath },
      });
    }
    const { errors, warnings: w } = validateConfigShape(global, { source: 'global' });
    if (errors.length > 0) {
      throw new OpcError('CONFIG_INVALID', `Config global inválida: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, {
        exitCode: 2,
        details: { errors },
      });
    }
    warnings.push(...w.map((x) => ({ ...x, source: 'global' })));
  } else global = null;
  let workspace = null;
  const wPath = workspaceConfigPath(workspaceRoot);
  try {
    workspace = readJson(wPath, MISSING);
  } catch (err) {
    if (err.code === 'INVALID_JSON') throw new OpcError('CONFIG_INVALID', 'O arquivo .opc.json não contém JSON válido.', { exitCode: 2, details: { path: wPath }, cause: err });
    throw err;
  }
  if (workspace !== MISSING) {
    if (!isPlainObject(workspace)) throw new OpcError('CONFIG_INVALID', 'O arquivo .opc.json precisa conter um objeto JSON.', { exitCode: 2, details: { path: wPath } });
    else {
      const { errors, warnings: w } = validateConfigShape(workspace, { source: 'workspace' });
      if (errors.length) throw new OpcError('CONFIG_INVALID', `Config workspace inválida: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { exitCode: 2, details: { path: wPath, errors } });
      warnings.push(...w.map((x) => ({ ...x, source: 'workspace' })));
    }
  } else workspace = null;
  const merged = mergeConfig(global, workspace);
  warnings.push(...merged.warnings.map((x) => ({ ...x, source: x.source ?? 'workspace' })));
  return { config: merged.config, global, workspace, hasGlobal: global !== null, warnings };
}

// F4a: somente a configuração global liga o lembrete; o workspace pode desligá-lo.
export function delegationAutoEnabled({ global = null, workspace = null } = {}) {
  if (global?.delegation?.auto !== true) return false;
  return workspace?.delegation?.auto !== false;
}

export function saveGlobalConfig(dataDir, cfg) {
  writeFileAtomic(globalConfigPath(dataDir), cfg, { mode: 0o600 });
}

// F2b: toggle the stop review gate in the existing global config.
export async function setStopGateEnabled(dataDir, enabled) {
  const file = globalConfigPath(dataDir);
  return withLock(joinPathF1(dataDir, 'config.lock'), { timeoutMs: 30000, purpose: 'setup-review-gate' }, () => {
    if (!fs.existsSync(file)) {
      throw new UsageError('NO_GLOBAL_CONFIG', 'Ainda não há configuração global do opc. Execute o onboarding com /opc:setup primeiro; ele pergunta sobre o gate de parada.');
    }
    let current;
    try {
      current = readJson(file);
    } catch (err) {
      if (err.code !== 'INVALID_JSON') throw err;
      throw new OpcError('CONFIG_INVALID', `Config global inválida. Execute "opc config validate" antes de alterar o gate.`, { exitCode: 2, details: { path: file }, cause: err });
    }
    if (!isPlainObject(current)) {
      throw new OpcError('CONFIG_INVALID', 'Config global inválida: precisa conter um objeto JSON. Execute "opc config validate" antes de alterar o gate.', { exitCode: 2, details: { path: file } });
    }
    const shape = validateConfigShape(current, { source: 'global' });
    if (shape.errors.length) {
      throw new OpcError('CONFIG_INVALID', `Config global inválida: ${shape.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}. Execute "opc config validate" antes de alterar o gate.`, { exitCode: 2, details: { path: file, errors: shape.errors } });
    }
    const next = setPath(current, 'stopGate.enabled', Boolean(enabled));
    saveGlobalConfig(dataDir, next);
    return next;
  });
}

export function saveWorkspaceConfig(workspaceRoot, cfg) {
  writeFileAtomic(workspaceConfigPath(workspaceRoot), cfg, { mode: 0o644 });
}

// ---- F1 (part B): edits, coercion, normalization, server validation ----
export function unsetPath(obj, dotted) {
  const [head, ...rest] = dotted.split('.');
  if (!isObj(obj) || !(head in obj)) return obj;
  const out = { ...obj };
  if (rest.length === 0) delete out[head];
  else out[head] = unsetPath(obj[head], rest.join('.'));
  return out;
}

function parseList(raw) {
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw new UsageError('INVALID_VALUE', 'lista deve ser um array JSON de strings não vazias');
    }
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string' || v.trim() === '')) {
      throw new UsageError('INVALID_VALUE', 'lista deve ser um array JSON de strings não vazias');
    }
    return parsed.map((v) => v.trim());
  }
  return text === '' ? [] : text.split(',').map((v) => v.trim()).filter(Boolean);
}

export function coerceValue(dotted, raw) {
  const desc = schemaFor(dotted);
  if (!desc) throw new UsageError('UNKNOWN_KEY', `chave de configuração desconhecida: "${dotted}"`);
  const text = String(raw).trim();
  if (desc.nullable && text === 'null') return null;
  switch (desc.type) {
    case 'boolean':
      if (['true', 'yes', 'on', '1'].includes(text.toLowerCase())) return true;
      if (['false', 'no', 'off', '0'].includes(text.toLowerCase())) return false;
      throw new UsageError('INVALID_VALUE', `${dotted} deve ser verdadeiro ou falso`);
    case 'integer': {
      if (!/^-?\d+$/.test(text)) throw new UsageError('INVALID_VALUE', `${dotted} deve ser um número inteiro`);
      const n = Number(text);
      const problem = checkValue(desc, n);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return n;
    }
    case 'enum':
      if (!desc.values.includes(text)) throw new UsageError('INVALID_VALUE', `${dotted} deve ser um destes valores: ${desc.values.join(', ')}`);
      return text;
    case 'string-list': case 'modelref-list': case 'enum-list': {
      const list = parseList(text);
      const problem = checkValue(desc, list);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return list;
    }
    case 'model-map': case 'modelref-list-map': case 'rules-map': case 'rules': case 'object': case 'json': {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new UsageError('INVALID_VALUE', `${dotted} espera um JSON válido`); }
      const problem = checkValue(desc, parsed);
      if (problem) throw new UsageError('INVALID_VALUE', `${dotted} ${problem}`);
      return parsed;
    }
    default:
      if (text === '') throw new UsageError('INVALID_VALUE', `${dotted} não pode ficar vazio`);
      return text;
  }
}

export function isListKey(dotted) {
  const desc = schemaFor(dotted);
  return Boolean(desc && desc.type.endsWith('-list'));
}

export function applyConfigEdit(cfg, op, dotted, value) {
  const base = isObj(cfg) ? cfg : {};
  if (op === 'set') return setPath(base, dotted, value);
  if (op === 'unset') return unsetPath(base, dotted);
  if (!isListKey(dotted)) throw new UsageError('NOT_A_LIST', `${dotted} não é uma chave de lista (use set)`);
  const current = Array.isArray(getPath(base, dotted)) ? getPath(base, dotted) : [];
  const items = Array.isArray(value) ? value : [value];
  if (op === 'add') return setPath(base, dotted, unionList(current, items));
  if (op === 'remove') {
    const missing = items.filter((v) => !current.includes(v));
    if (missing.length) throw new UsageError('NOT_IN_LIST', `${dotted} não contém: ${missing.join(', ')}`);
    return setPath(base, dotted, current.filter((v) => !items.includes(v)));
  }
  throw new UsageError('USAGE', `operação de configuração desconhecida: "${op}"`);
}

export function normalizeEditValue(dotted, value, { catalog, aliases = {}, defaultProvider = null }) {
  const desc = schemaFor(dotted);
  if (!desc || value === null) return value;
  const ref = (v, allowClaude = false) => resolveModelRef(v, { catalog, aliases, defaultProvider, allowClaude }).value;
  switch (desc.type) {
    case 'model': return normalizeModelId(value, { catalog, aliases, defaultProvider }).full;
    case 'modelref': return ref(value);
    case 'modelref-or-claude': return ref(value, true);
    case 'modelref-list': return value.map((v) => ref(v));
    case 'model-map': return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeModelId(v, { catalog, defaultProvider }).full]));
    case 'modelref-list-map': return Object.fromEntries(Object.entries(value).map(([k, list]) => [k, list.map((v) => ref(v))]));
    default: return value;
  }
}

export function modelRefsIn(cfg) {
  const out = [];
  const push = (path, value, kind) => { if (typeof value === 'string' && value !== '') out.push({ path, value, kind }); };
  push('defaultModel', cfg.defaultModel, 'model');
  push('reviewModel', cfg.reviewModel, 'modelref');
  push('stopGate.model', cfg.stopGate?.model, 'modelref');
  push('orchestrate.planner', cfg.orchestrate?.planner, 'modelref');
  push('orchestrate.synthesizer', cfg.orchestrate?.synthesizer, 'modelref-or-claude');
  push('conclave.judge', cfg.conclave?.judge, 'modelref-or-claude');
  for (const [name, target] of Object.entries(cfg.aliases ?? {})) push(`aliases.${name}`, target, 'model');
  for (const group of ['routing.tasks', 'routing.tiers', 'conclave.pools']) {
    for (const [name, list] of Object.entries(getPath(cfg, group) ?? {})) {
      (Array.isArray(list) ? list : []).forEach((v, i) => push(`${group}.${name}[${i}]`, v, 'modelref'));
    }
  }
  return out;
}

function resolveStored(ref, cfg, catalog) {
  if (ref.kind === 'modelref-or-claude' && ref.value === 'claude') return { full: null };
  if (ref.kind !== 'model' && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value)) {
    const target = cfg.aliases[ref.value];
    return { full: normalizeModelId(target, { catalog, fullOnly: true }).full };
  }
  return { full: normalizeModelId(ref.value, { catalog, fullOnly: true }).full };
}

export function validateAgainstServer(cfg, { catalog, agents = [], opencodeConfig = null }) {
  const errors = [];
  const warnings = [];
  for (const ref of modelRefsIn(cfg)) {
    if (ref.path.startsWith('aliases.') && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value)) {
      errors.push({ path: ref.path, code: 'BROKEN_ALIAS', message: `o alias aponta para outro alias "${ref.value}" (só é permitido 1 nível)` });
      continue;
    }
    try {
      resolveStored(ref, cfg, catalog);
    } catch (err) {
      const viaAlias = ref.kind !== 'model' && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value);
      errors.push({ path: ref.path, code: viaAlias ? 'BROKEN_ALIAS' : (err.code ?? 'UNKNOWN_MODEL'), message: viaAlias ? `o alias "${ref.value}" está inválido: ${err.message}` : err.message });
    }
  }
  if (cfg.defaultProvider && !catalog.connected.has(cfg.defaultProvider)) {
    errors.push({ path: 'defaultProvider', code: 'UNKNOWN_PROVIDER', message: `o provider "${cfg.defaultProvider}" não está conectado` });
  }
  if (cfg.defaultVariant) {
    const modelId = cfg.defaultModel ?? opencodeConfig?.model ?? null;
    const entry = modelId ? catalog.byFull.get(modelId) : null;
    if (!entry) errors.push({ path: 'defaultVariant', code: 'UNKNOWN_VARIANT', message: 'defaultVariant precisa de um defaultModel válido (ou do "model" declarado na configuração do OpenCode)' });
    else {
      try { validateVariant(entry, cfg.defaultVariant); } catch (err) { errors.push({ path: 'defaultVariant', code: err.code, message: err.message }); }
    }
  }
  if (cfg.defaultAgent) {
    const agent = agents.find((a) => a.name === cfg.defaultAgent);
    if (!agent) errors.push({ path: 'defaultAgent', code: 'UNKNOWN_AGENT', message: `o agent "${cfg.defaultAgent}" não foi encontrado em /agent` });
    else if (agent.mode === 'subagent') errors.push({ path: 'defaultAgent', code: 'AGENT_MODE', message: `o agent "${cfg.defaultAgent}" só pode ser subagent e não pode ser usado na sessão` });
  }
  if (cfg.conclave?.defaultPool && !Object.prototype.hasOwnProperty.call(cfg.conclave.pools ?? {}, cfg.conclave.defaultPool)) {
    errors.push({ path: 'conclave.defaultPool', code: 'UNKNOWN_POOL', message: `o pool "${cfg.conclave.defaultPool}" não está definido em conclave.pools` });
  }
  return { errors, warnings };
}

export function policyViolations(cfg, { catalog, agents = [] }) {
  const errors = [];
  const deny = (path, value, rule) => errors.push({ path, code: 'POLICY_DENIED', message: `"${value}" negado pela regra ${rule}`, rule });
  for (const ref of modelRefsIn(cfg)) {
    let full;
    try { full = resolveStored(ref, cfg, catalog).full; } catch {
      full = ref.kind !== 'model' && Object.prototype.hasOwnProperty.call(cfg.aliases ?? {}, ref.value)
        ? cfg.aliases[ref.value]
        : ref.value;
    }
    if (!full) continue;
    const r = evaluate('model', full, cfg.policy);
    if (!r.allowed) deny(ref.path, full, r.rule);
  }
  if (cfg.defaultProvider) {
    const r = evaluate('provider', cfg.defaultProvider, cfg.policy);
    if (!r.allowed) deny('defaultProvider', cfg.defaultProvider, r.rule);
  }
  if (cfg.defaultAgent) {
    const agent = agents.find((a) => a.name === cfg.defaultAgent) ?? { name: cfg.defaultAgent };
    const r = evaluateAgent(agent, cfg.policy);
    if (!r.allowed) deny('defaultAgent', cfg.defaultAgent, r.rule);
  }
  return errors;
}

export function configPaths({ dataDir, workspaceRoot }) {
  return {
    dataDir,
    global: joinPathF1(dataDir, 'config.json'),
    workspace: joinPathF1(workspaceRoot, '.opc.json'),
    draft: joinPathF1(dataDir, 'config.draft.json'),
  };
}
// ---- end F1 ----
