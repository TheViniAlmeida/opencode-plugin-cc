// Global config + workspace override with the restrictive merge of spec §3.2 (F0 base; F1 completes).
import fs from 'node:fs';
import path from 'node:path';

import { OpcError } from './opc-error.mjs';
import { readJson, writeFileAtomic } from './state.mjs';

export const DEFAULT_CONFIG = Object.freeze({
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
  routing: {
    tasks: {},
    tiers: {},
    fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 },
  },
  conclave: { pools: {}, defaultPool: null, judge: 'claude', rounds: 1, quorum: 2, memberTimeoutSec: 900 },
  orchestrate: { planner: null, maxSubtasks: 5, synthesizer: 'claude' },
  delegation: { auto: false },
  jobs: { maxActive: 8, maxParallel: 4 },
  server: { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } },
});

export const LOCKED_KEYS = Object.freeze(['policy', 'permissionProfiles', 'server.configOverride']);

const WORKSPACE_OVERRIDABLE = Object.freeze([
  'defaultProvider', 'defaultModel', 'defaultVariant', 'defaultAgent', 'aliases', 'reviewModel',
  'routing', 'conclave', 'orchestrate', 'project', 'stopGate.model',
]);
const POLICY_LIST_KINDS = Object.freeze(['providers', 'models', 'agents']);
const SECRET_KEY_RE = /token|password|secret|api[-_]?key/i;
const MISSING = Symbol('missing');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const [head, ...rest] = String(dotted).split('.');
  const base = isPlainObject(obj) ? obj : {};
  if (rest.length === 0) return { ...base, [head]: value };
  return { ...base, [head]: setPath(base[head], rest.join('.'), value) };
}

function unsetPath(obj, dotted) {
  const [head, ...rest] = String(dotted).split('.');
  if (!isPlainObject(obj) || !(head in obj)) return obj;
  const copy = { ...obj };
  if (rest.length === 0) delete copy[head];
  else copy[head] = unsetPath(copy[head], rest.join('.'));
  return copy;
}

export function matchesGlob(value, glob) {
  const escaped = String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(String(value));
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

const isStr = (v) => typeof v === 'string';
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isBool = (v) => typeof v === 'boolean';
const isStrMap = (v) => isPlainObject(v) && Object.values(v).every(isStr);
const isListMap = (v) => isPlainObject(v) && Object.values(v).every(isStrList);
const isRuleList = (v) => Array.isArray(v) && v.every((r) => isPlainObject(r) && isStr(r.permission) && isStr(r.pattern)
  && ['allow', 'deny', 'ask'].includes(r.action));

const SHAPE = {
  defaultProvider: [isStrOrNull, 'texto ou null'],
  defaultModel: [isStrOrNull, 'texto ou null'],
  defaultVariant: [isStrOrNull, 'texto ou null'],
  defaultAgent: [isStrOrNull, 'texto ou null'],
  aliases: [isStrMap, 'mapa de texto'],
  reviewModel: [isStrOrNull, 'texto ou null'],
  stopGate: [isPlainObject, 'objeto'],
  'stopGate.enabled': [isBool, 'booleano'],
  'stopGate.model': [isStrOrNull, 'texto ou null'],
  project: [isPlainObject, 'objeto'],
  'project.goal': [isStrOrNull, 'texto ou null'],
  'project.scope': [isStrList, 'lista de texto'],
  'project.taskTypes': [isStrList, 'lista de texto'],
  policy: [isPlainObject, 'objeto'],
  'policy.providers': [isPlainObject, 'objeto'],
  'policy.models': [isPlainObject, 'objeto'],
  'policy.agents': [isPlainObject, 'objeto'],
  'policy.tools': [isPlainObject, 'objeto'],
  'policy.providers.allow': [isStrList, 'lista de texto'],
  'policy.providers.deny': [isStrList, 'lista de texto'],
  'policy.models.allow': [isStrList, 'lista de texto'],
  'policy.models.deny': [isStrList, 'lista de texto'],
  'policy.agents.allow': [isStrList, 'lista de texto'],
  'policy.agents.deny': [isStrList, 'lista de texto'],
  'policy.tools.deny': [isStrList, 'lista de texto'],
  'policy.sensitivePaths': [isStrList, 'lista de texto'],
  'policy.destructiveBash': [isStrList, 'lista de texto'],
  'policy.approver': [(v) => v === 'user' || v === 'claude', '"user" ou "claude"'],
  'policy.permissionTimeoutSec': [isPosNum, 'número > 0'],
  permissionProfiles: [isPlainObject, 'objeto'],
  routing: [isPlainObject, 'objeto'],
  'routing.tasks': [isListMap, 'mapa de listas'],
  'routing.tiers': [isListMap, 'mapa de listas'],
  'routing.fallback.enabled': [isBool, 'booleano'],
  'routing.fallback.maxAttempts': [isPosInt, 'inteiro > 0'],
  'routing.fallback.maxProviderRetries': [isPosInt, 'inteiro > 0'],
  'routing.fallback.maxRetryWaitSec': [isPosNum, 'número > 0'],
  conclave: [isPlainObject, 'objeto'],
  'conclave.pools': [isListMap, 'mapa de listas'],
  'conclave.defaultPool': [isStrOrNull, 'texto ou null'],
  'conclave.judge': [isStr, 'texto'],
  'conclave.rounds': [(v) => Number.isInteger(v) && v >= 1 && v <= 3, 'inteiro entre 1 e 3'],
  'conclave.quorum': [(v) => Number.isInteger(v) && v >= 2, 'inteiro >= 2'],
  'conclave.memberTimeoutSec': [isPosNum, 'número > 0'],
  orchestrate: [isPlainObject, 'objeto'],
  'orchestrate.planner': [isStrOrNull, 'texto ou null'],
  'orchestrate.maxSubtasks': [(v) => Number.isInteger(v) && v >= 2, 'inteiro >= 2'],
  'orchestrate.synthesizer': [isStr, 'texto'],
  delegation: [isPlainObject, 'objeto'],
  'delegation.auto': [isBool, 'booleano'],
  jobs: [isPlainObject, 'objeto'],
  'jobs.maxActive': [isPosInt, 'inteiro > 0'],
  'jobs.maxParallel': [isPosInt, 'inteiro > 0'],
  server: [isPlainObject, 'objeto'],
  'server.bootTimeoutSec': [isPosNum, 'número > 0'],
  'server.requestTimeoutSec': [isPosNum, 'número > 0'],
  'server.configOverride': [isPlainObject, 'objeto'],
};

function collectSecretLikeKeys(value, prefix, out) {
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY_RE.test(k)) out.push(p);
    collectSecretLikeKeys(v, p, out);
  }
}

export function validateConfigShape(obj, { source = 'global' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(obj)) {
    errors.push({ path: '', message: 'a configuração precisa ser um objeto JSON' });
    return { errors, warnings };
  }
  for (const key of Object.keys(obj)) {
    if (!(key in DEFAULT_CONFIG)) warnings.push({ path: key, message: 'chave desconhecida (ignorada)' });
  }
  for (const [dotted, [check, expected]] of Object.entries(SHAPE)) {
    const value = getPath(obj, dotted);
    if (value !== undefined && !check(value)) errors.push({ path: dotted, message: `valor inválido: esperado ${expected}` });
  }
  if (isPlainObject(obj.permissionProfiles)) {
    for (const [name, rules] of Object.entries(obj.permissionProfiles)) {
      if (!isRuleList(rules)) errors.push({ path: `permissionProfiles.${name}`, message: 'valor inválido: esperado lista de regras' });
    }
  }
  const secretLike = [];
  collectSecretLikeKeys(obj, '', secretLike);
  for (const p of secretLike) warnings.push({ path: p, message: 'chave com cara de segredo: não guarde segredos na config do opc' });
  if (source === 'workspace') {
    for (const key of LOCKED_KEYS) {
      if (getPath(obj, key) !== undefined && key !== 'policy') {
        warnings.push({ path: key, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
      }
    }
  }
  return { errors, warnings };
}

function intersectAllow(globalAllow, wsAllow) {
  if (wsAllow.length === 0) return { allow: [...globalAllow], dropped: [], empty: false };
  if (globalAllow.length === 0) return { allow: [...wsAllow], dropped: [], empty: false };
  const keptWs = wsAllow.filter((w) => globalAllow.some((g) => matchesGlob(w, g)));
  const keptGlobal = globalAllow.filter((g) => wsAllow.some((w) => matchesGlob(g, w)));
  const allow = [...new Set([...keptWs, ...keptGlobal])];
  const dropped = wsAllow.filter((w) => !allow.includes(w) && !keptGlobal.some((g) => matchesGlob(g, w)));
  return { allow: allow.length > 0 ? allow : [...globalAllow], dropped, empty: allow.length === 0 };
}

function mergeWorkspacePolicy(effective, wsPolicy, warnings) {
  if (wsPolicy === undefined) return effective;
  if (!isPlainObject(wsPolicy)) {
    warnings.push({ path: 'policy', message: 'policy do .opc.json inválida (ignorada)' });
    return effective;
  }
  const policy = clone(effective.policy);
  for (const [key, value] of Object.entries(wsPolicy)) {
    if (POLICY_LIST_KINDS.includes(key) && isPlainObject(value)) {
      for (const [listName, list] of Object.entries(value)) {
        const p = `policy.${key}.${listName}`;
        if (!isStrList(list) || !['allow', 'deny'].includes(listName)) {
          warnings.push({ path: p, message: 'entrada inválida no .opc.json (ignorada)' });
          continue;
        }
        if (listName === 'deny') {
          policy[key].deny = [...new Set([...policy[key].deny, ...list])];
        } else {
          const res = intersectAllow(policy[key].allow, list);
          policy[key].allow = res.allow;
          for (const _d of res.dropped) warnings.push({ path: p, message: 'entrada amplia o allow global (ignorada)' });
          if (res.empty) {
            policy[key].deny = [...new Set([...policy[key].deny, '*'])];
            warnings.push({ path: p, message: 'interseção vazia com o allow global: nada fica permitido' });
          }
        }
      }
    } else if (key === 'tools' && isPlainObject(value) && isStrList(value.deny ?? [])) {
      policy.tools.deny = [...new Set([...policy.tools.deny, ...(value.deny ?? [])])];
      for (const extra of Object.keys(value).filter((k) => k !== 'deny')) {
        warnings.push({ path: `policy.tools.${extra}`, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
      }
    } else if ((key === 'sensitivePaths' || key === 'destructiveBash') && isStrList(value)) {
      policy[key] = [...new Set([...policy[key], ...value])];
    } else if (key === 'approver' && value === 'user') {
      policy.approver = 'user';
    } else {
      warnings.push({ path: `policy.${key}`, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
    }
  }
  return { ...effective, policy };
}

export function mergeConfig(globalCfg, workspaceCfg) {
  const warnings = [];
  let config = deepMerge(clone(DEFAULT_CONFIG), isPlainObject(globalCfg) ? globalCfg : {});
  if (!isPlainObject(workspaceCfg)) return { config, warnings };
  const { errors } = validateConfigShape(workspaceCfg, { source: 'workspace' });
  const invalid = new Set(errors.map((e) => e.path));
  for (const e of errors) warnings.push({ path: e.path, message: `.opc.json: ${e.message} (ignorado)` });
  let ws = workspaceCfg;
  for (const p of invalid) ws = unsetPath(ws, p);
  config = mergeWorkspacePolicy(config, ws.policy, warnings);
  for (const key of ['permissionProfiles', 'server.configOverride']) {
    if (getPath(ws, key) !== undefined) {
      warnings.push({ path: key, message: 'chave travada: só vale na config global (ignorada no .opc.json)' });
    }
  }
  for (const dotted of WORKSPACE_OVERRIDABLE) {
    const value = getPath(ws, dotted);
    if (value === undefined) continue;
    const current = getPath(config, dotted);
    config = setPath(config, dotted, isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : clone(value));
  }
  const handledTop = new Set(['policy', 'permissionProfiles', ...WORKSPACE_OVERRIDABLE.map((k) => k.split('.')[0])]);
  for (const key of Object.keys(ws)) {
    if (handledTop.has(key)) continue;
    if (key === 'server') {
      for (const sub of Object.keys(ws.server ?? {}).filter((k) => k !== 'configOverride')) {
        warnings.push({ path: `server.${sub}`, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
      }
      continue;
    }
    warnings.push({ path: key, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
  }
  if (isPlainObject(ws.stopGate)) {
    for (const sub of Object.keys(ws.stopGate).filter((k) => k !== 'model')) {
      warnings.push({ path: `stopGate.${sub}`, message: 'chave não sobrescrevível no .opc.json (ignorada)' });
    }
  }
  return { config, warnings };
}

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
      warnings.push(...w.filter((x) => x.message.startsWith('chave com cara')).map((x) => ({ ...x, source: 'workspace' })));
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
