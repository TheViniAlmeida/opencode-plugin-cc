// Global config + workspace override with the restrictive merge of spec §3.2 (F0 base; F1 completes).
import fs from 'node:fs';
import path from 'node:path';

import { OpcError } from './opc-error.mjs';
import { readJson, writeFileAtomic } from './state.mjs';
import { matchesAny } from './models.mjs';

// ---- F1: complete schema, restrictive merge, locked keys, edits and server validation (spec §3.2, §3.3) ----
export const LOCKED_KEYS = Object.freeze(['policy', 'permissionProfiles', 'server.configOverride']);
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
  conclave: { pools: {}, defaultPool: null, judge: 'claude', rounds: 1, quorum: 2, memberTimeoutSec: 900 },
  orchestrate: { planner: null, maxSubtasks: 5, synthesizer: 'claude' },
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
  'orchestrate.planner': schemaField('modelref', { nullable: true }),
  'orchestrate.maxSubtasks': schemaField('integer', { min: 2, max: 20 }),
  'orchestrate.synthesizer': schemaField('modelref-or-claude'),
  'delegation.auto': schemaField('boolean'),
  'jobs.maxActive': schemaField('integer', { min: 1, max: 64 }),
  'jobs.maxParallel': schemaField('integer', { min: 1, max: 32 }),
  'server.bootTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.requestTimeoutSec': schemaField('integer', { min: 1, max: 600 }),
  'server.configOverride': schemaField('object'),
});

const MAP_ENTRY = Object.freeze({ 'model-map': schemaField('model'), 'modelref-list-map': schemaField('modelref-list'), 'rules-map': schemaField('rules'), object: schemaField('json') });
const GROUPS = new Set(Object.keys(CONFIG_SCHEMA).flatMap((k) => k.split('.').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('.'))));
const SECRET_LIKE = /(token|password|secret|api[-_]?key)/i;
const WORKSPACE_PREFERENCE_KEYS = ['defaultProvider', 'defaultModel', 'defaultVariant', 'defaultAgent', 'aliases', 'reviewModel', 'stopGate.model', 'project', 'routing', 'conclave', 'orchestrate'];
const WORKSPACE_POLICY_LISTS = ['policy.providers.allow', 'policy.providers.deny', 'policy.models.allow', 'policy.models.deny', 'policy.agents.allow', 'policy.agents.deny', 'policy.tools.deny', 'policy.sensitivePaths', 'policy.destructiveBash'];
const MODEL_TYPES = new Set(['model', 'modelref', 'modelref-or-claude', 'model-map', 'modelref-list-map', 'modelref-list']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
  if (value === null) return desc.nullable ? null : 'must not be null';
  switch (desc.type) {
    case 'string': case 'model': case 'modelref': case 'modelref-or-claude':
      return typeof value === 'string' && value.trim() !== '' ? null : 'must be a non-empty string';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'integer':
      if (!Number.isInteger(value)) return 'must be an integer';
      if (value < desc.min || value > desc.max) return `must be between ${desc.min} and ${desc.max}`;
      return null;
    case 'enum':
      return desc.values.includes(value) ? null : `must be one of: ${desc.values.join(', ')}`;
    case 'string-list': case 'modelref-list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'must be a list of non-empty strings';
    case 'enum-list':
      if (!Array.isArray(value)) return 'must be a list';
      return value.every((v) => desc.values.includes(v)) ? null : `items must be in: ${desc.values.join(', ')}`;
    case 'model-map':
      return isObj(value) && Object.values(value).every((v) => typeof v === 'string' && v.trim() !== '') ? null : 'must map names to model IDs';
    case 'modelref-list-map':
      return isObj(value) && Object.values(value).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')) ? null : 'must map names to lists of models';
    case 'rules': return checkRules(value);
    case 'rules-map':
      if (!isObj(value)) return 'must map profile names to rule lists';
      for (const rules of Object.values(value)) { const e = checkRules(rules); if (e) return e; }
      return null;
    case 'object': return isObj(value) ? null : 'must be an object';
    case 'json': return null;
    default: return `unknown schema type ${desc.type}`;
  }
}

function checkRules(rules) {
  if (!Array.isArray(rules)) return 'rules must be a list';
  const ok = rules.every((r) => isObj(r) && typeof r.permission === 'string' && typeof r.pattern === 'string' && ['allow', 'deny', 'ask'].includes(r.action));
  return ok ? null : 'each rule needs {permission, pattern, action: allow|deny|ask}';
}

export function findSecretLikeKeys(obj, prefix = '') {
  const hits = [];
  if (!isObj(obj) && !Array.isArray(obj)) return hits;
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!Array.isArray(obj) && SECRET_LIKE.test(key)) hits.push(p);
    hits.push(...findSecretLikeKeys(value, p));
  }
  return hits;
}

export function validateConfigShape(obj, { source = 'global' } = {}) {
  const errors = [];
  const warnings = [];
  if (obj === null || obj === undefined) return { errors, warnings };
  if (!isObj(obj)) return { errors: [{ path: '', code: 'INVALID_VALUE', message: `${source} config must be a JSON object` }], warnings };
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${key}` : key;
      const desc = CONFIG_SCHEMA[p];
      if (desc) {
        const problem = checkValue(desc, value);
        if (problem) errors.push({ path: p, code: 'INVALID_VALUE', message: problem });
      } else if (GROUPS.has(p)) {
        if (isObj(value)) walk(value, p);
        else errors.push({ path: p, code: 'INVALID_VALUE', message: 'must be an object' });
      } else {
        warnings.push({ path: p, code: 'UNKNOWN_KEY', message: `unknown key (ignored) in ${source} config` });
      }
    }
  };
  walk(obj, '');
  if (source === 'workspace') {
    for (const key of LOCKED_KEYS) {
      if (getPath(obj, key) !== undefined) warnings.push({ path: key, code: 'UNKNOWN_KEY', message: 'locked key (global only)' });
    }
  }
  for (const p of findSecretLikeKeys(obj)) {
    warnings.push({ path: p, code: 'SECRET_LIKE_KEY', message: 'key looks like a secret; config files must never hold secrets (use env vars or the vault)' });
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
    warnings.push({ path: error.path, code: 'WORKSPACE_IGNORED', message: `.opc.json: ${error.message}; ignored` });
    if (error.path) ws = unsetConfigPath(ws, error.path);
  }
  const ignore = (p, why) => warnings.push({ path: p, code: 'WORKSPACE_IGNORED', message: `.opc.json: ${why}; ignored` });
  ws = dropUnknownConfigKeys(ws, '', (p) => ignore(p, 'unknown key'));
  for (const [key, value] of Object.entries(ws)) {
    if (key === 'policy') {
      if (!isObj(value)) { ignore('policy', 'must be an object'); continue; }
      mergeWorkspacePolicy(config, value, ignore, warnings);
    } else if (key === 'stopGate' && isObj(value)) {
      for (const [sub, v] of Object.entries(value)) {
        if (sub === 'model') config.stopGate.model = cloneJson(v);
        else ignore(`stopGate.${sub}`, 'not overridable per workspace');
      }
    } else if (WORKSPACE_PREFERENCE_KEYS.includes(key)) {
      config[key] = isObj(value) && isObj(config[key]) ? mergeDeep(config[key], value) : cloneJson(value);
    } else if (isLockedKey(key) || key === 'server') {
      ignore(key, 'locked key (global only)');
      if (key === 'server' && isObj(value) && Object.hasOwn(value, 'configOverride')) ignore('server.configOverride', 'locked key (global only)');
    } else if (key in DEFAULT_CONFIG) {
      ignore(key, 'not overridable per workspace');
    } else {
      ignore(key, 'unknown key');
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
        if (!Array.isArray(list)) { ignore(lp, 'must be a list'); continue; }
        if (listName === 'deny') {
          config.policy[sub].deny = unionList(config.policy[sub].deny, list);
        } else if (listName === 'allow' && sub !== 'tools') {
          if (list.length === 0) continue;
          const globalAllow = config.policy[sub].allow;
          if (globalAllow.length > 0) {
            for (const entry of list) {
              if (!matchesAny(entry, globalAllow)) warnings.push({ path: lp, code: 'WORKSPACE_ALLOW_NARROWED', message: `.opc.json: "${entry}" is outside the global allow list; only the intersection applies` });
            }
          }
          config.policy[sub].allowWorkspace = [...list];
        } else {
          ignore(lp, 'only allow/deny lists can be set per workspace');
        }
      }
    } else if ((sub === 'sensitivePaths' || sub === 'destructiveBash') && Array.isArray(value)) {
      config.policy[sub] = unionList(config.policy[sub], value);
    } else {
      ignore(p, 'locked key (global only)');
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
  warnings.push(...merged.warnings.map((x) => ({ ...x, source: 'workspace' })));
  return { config: merged.config, global, workspace, hasGlobal: global !== null, warnings };
}

export function saveGlobalConfig(dataDir, cfg) {
  writeFileAtomic(globalConfigPath(dataDir), cfg, { mode: 0o600 });
}

export function saveWorkspaceConfig(workspaceRoot, cfg) {
  writeFileAtomic(workspaceConfigPath(workspaceRoot), cfg, { mode: 0o644 });
}
