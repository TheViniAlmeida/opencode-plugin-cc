// Shape recording and diffing used by tests/live/contract.mjs (kept import-safe for unit tests).
import fs from 'node:fs';

// V2 GET endpoints and passive SSE events consumed by the scheduled live contract runner.
// { name, method: 'GET', path, used: [dotted fields opc reads], optionalUsed?: [fields read only if present] }.
export const PROBES = [
  { name: 'info', method: 'GET', path: '/api/info', used: ['version', 'pid', 'urls'], optionalUsed: ['paths'] },
  { name: 'agent', method: 'GET', path: '/api/agent', used: ['[].id', '[].name', '[].mode'], optionalUsed: ['[].permissions'] },
  { name: 'config', method: 'GET', path: '/api/config', used: [] },
  { name: 'session.active', method: 'GET', path: '/api/session/active', used: [] },
  { name: 'provider', method: 'GET', path: '/api/provider', used: ['[].id', '[].name', '[].activation'] },
  { name: 'model', method: 'GET', path: '/api/model', used: [] },
  { name: 'command', method: 'GET', path: '/api/command', used: ['[].name'] },
  { name: 'skill', method: 'GET', path: '/api/skill', used: [] },
];
export const EVENT_TYPES = ['server.connected'];

// Only config fields consumed by the plugin belong in snapshots.
export const CONFIG_USED_FIELDS = ['share', 'autoshare', 'model', 'small_model', 'mcp', 'agent', 'provider', 'permission'];

// Known OpenCode config/agent schema properties; all other nested names are user data.
export const KNOWN_CONFIG_PROPS = new Set([
  'enabled', 'type', 'command', 'url', 'environment', 'headers', 'timeout', 'model',
  'mode', 'prompt', 'description', 'temperature', 'top_p', 'tools', 'disable',
  'hidden', 'permission', 'options', 'models', 'name', 'npm', 'api', 'variant',
  'variants', 'steps', 'color', 'id', 'permissions', 'action', 'resource', 'effect',
]);

// Maps whose keys are user data (provider names, MCP names…): only the value shape is recorded.
export const MAP_PATHS = new Set([
  'config.agent', 'config.mcp', 'config.provider', 'config.command', 'config.mode', 'config.lsp', 'config.formatter',
  'config.permission', 'session.status', 'session.active',
  'agent', 'command', 'skill',
  'provider.all[].models', 'provider.default', 'provider.all[].options', 'provider.all[].models.*.options',
  'provider.all[].models.*.headers', 'provider.all[].models.*.variants',
]);

function mergeShapes(shapes) {
  if (shapes.length === 0) return 'empty';
  const first = shapes[0];
  if (shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(first))) return first;
  if (shapes.every((shape) => shape && typeof shape === 'object' && !Array.isArray(shape))) {
    const keys = [...new Set(shapes.flatMap((shape) => Object.keys(shape)))].sort();
    return Object.fromEntries(keys.map((key) => [key, mergeShapes(shapes.filter((shape) => Object.hasOwn(shape, key)).map((shape) => shape[key]))]));
  }
  if (shapes.every(Array.isArray)) return mergeShapes(shapes.flatMap((shape) => shape));
  return 'mixed';
}

function collapseKeys(value, at, keys) {
  const childPath = (key) => at ? `${at}.${key}` : key;
  const collapseAll = MAP_PATHS.has(at) || /(^|\.)permission(\.|\[|$)/.test(at);
  if (at.startsWith('config.') || at === 'agent[]' || at.startsWith('agent[].') || collapseAll) {
    const groups = new Map();
    for (const key of keys) {
      const safeKey = collapseAll || !KNOWN_CONFIG_PROPS.has(key) ? '*' : key;
      if (!groups.has(safeKey)) groups.set(safeKey, []);
      groups.get(safeKey).push(shapeOf(value[key], childPath(safeKey)));
    }
    if (collapseAll && keys.length === 0) return { '*': 'empty' };
    return Object.fromEntries([...groups.keys()].sort().map((key) => [key, mergeShapes(groups.get(key))]));
  }
  return Object.fromEntries(keys.sort().map((key) => [key, shapeOf(value[key], childPath(key))]));
}

export function toolAttempted(tools, asked, tool) {
  return tools.some((part) => part.tool === tool && ['error', 'completed'].includes(part.status))
    || asked.some((event) => (event.action ?? event.permission) === tool);
}

function inconclusiveReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') throw new TypeError('INCONCLUSIVO exige um motivo em PT-BR');
  return `INCONCLUSIVO (${reason.trim()})`;
}

export function evidenceVerdict(attempted, blocked, reason) {
  return attempted ? (blocked ? 'DENY' : 'ALLOW') : inconclusiveReason(reason);
}

export function mergeVerdict({ overrideApplied, userConfig, effectiveConfig, overridePresent, reason }) {
  const key = ['model', 'agent', 'provider'].find((candidate) => Object.hasOwn(userConfig ?? {}, candidate));
  if (!overrideApplied || !overridePresent || !key) return { verdict: inconclusiveReason(reason), key: key ?? null };
  const survived = Object.hasOwn(effectiveConfig ?? {}, key)
    && JSON.stringify(effectiveConfig[key]) === JSON.stringify(userConfig[key]);
  return { verdict: survived ? 'MERGE' : 'REPLACE', key };
}

export function shapeOf(value, at = '') {
  if (value === null) return 'null';
  if (at === 'config' && Array.isArray(value)) return ['object'];
  if (Array.isArray(value)) return value.length === 0 ? ['empty'] : [shapeOf(value[0], `${at}[]`)];
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (at === 'config') {
      return Object.fromEntries(CONFIG_USED_FIELDS.filter((key) => Object.hasOwn(value, key)).map((key) => [key, shapeOf(value[key], `config.${key}`)]));
    }
    return collapseKeys(value, at, keys);
  }
  return typeof value;
}

export function lookup(shape, dotted) {
  let cur = shape;
  for (const part of dotted.split('.')) {
    if (part === '[]') {
      if (!Array.isArray(cur)) return undefined;
      [cur] = cur;
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = cur[part];
    }
  }
  return cur;
}

const kindOf = (shape) => {
  if (Array.isArray(shape)) return 'array';
  return typeof shape === 'object' && shape !== null ? 'object' : shape;
};

export function diffShapes(real, fake, used = [], optionalUsed = []) {
  const problems = [];
  if (Array.isArray(real) !== Array.isArray(fake) || typeof real !== typeof fake) {
    problems.push({ field: '(root)', real: JSON.stringify(real).slice(0, 80), fake: JSON.stringify(fake).slice(0, 80) });
    return problems;
  }
  for (const field of used) {
    const r = lookup(real, field);
    const f = lookup(fake, field);
    if (r === undefined) problems.push({ field, real: 'ausente', fake: JSON.stringify(f ?? 'ausente') });
    else if (JSON.stringify(r) !== JSON.stringify(f)) {
      problems.push({ field, real: JSON.stringify(r).slice(0, 80), fake: JSON.stringify(f ?? 'ausente').slice(0, 80) });
    }
  }
  for (const field of optionalUsed) {
    const r = lookup(real, field);
    const f = lookup(fake, field);
    if (r !== undefined && f !== undefined && kindOf(r) !== kindOf(f)) {
      problems.push({ field, real: String(kindOf(r)), fake: String(kindOf(f)) });
    }
  }
  return problems;
}

// OpenCode 2.0.22 contract (F6). Samples are real responses captured on 06/10/2026 and sanitized; each shape
// lists the keys opc reads. `V2_SHAPES.files` maps every committed sample to the shape it must satisfy
// (`null` = recorded for reference only).
export const V2_CONTRACT_DIR = new URL('./contract/opencode-2.0.22/', import.meta.url);

export const V2_SHAPES = Object.freeze({
  info: ['version', 'pid', 'urls', 'paths'],
  session: ['id', 'projectID', 'agent', 'model', 'permissions', 'time', 'title', 'location', 'cost', 'tokens'],
  'message.user': ['id', 'type', 'time', 'text'],
  'message.assistant': ['id', 'type', 'time', 'agent', 'model', 'content', 'cost', 'tokens'],
  'message.idle': ['id', 'type', 'time', 'outcome'],
  event: ['id', 'type', 'data'],
  permissionRequest: ['id', 'sessionID', 'action', 'resources', 'save', 'source'],
  form: ['id', 'sessionID', 'title', 'metadata', 'fields'],
  model: ['id', 'modelID', 'providerID', 'name', 'capabilities', 'variants', 'status'],
  agent: ['id', 'name', 'mode', 'hidden', 'permissions'],
  provider: ['id', 'name', 'activation'],
  export: ['info', 'messages'],
  files: {
    'info.json': 'info',
    'session.json': 'session',
    'messages-turn.json': null,
    'messages-failed.json': null,
    'messages-interrupted.json': null,
    'permission-request.json': 'permissionRequest',
    'form.json': 'form',
    'model.json': null,
    'model-default.json': null,
    'agent.json': null,
    'provider.json': null,
    'command.json': null,
    'config.json': null,
    'export.json': 'export',
    'session-list.json': null,
    'prompt.json': null,
    'active.json': null,
    'interrupt.json': null,
  },
});

// Throws an AssertionError-like Error naming the first missing key.
export function assertShape(name, value) {
  const keys = V2_SHAPES[name];
  if (!Array.isArray(keys)) throw new Error(`unknown V2 shape: ${name}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: expected an object`);
  for (const key of keys) {
    if (!(key in value)) throw Object.assign(new Error(`${name}: missing key ${key}`), { code: 'ERR_ASSERTION' });
  }
  return value;
}

export function loadContractSample(name) {
  const text = fs.readFileSync(new URL(name, V2_CONTRACT_DIR), 'utf8');
  if (name.endsWith('.jsonl')) return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (name.endsWith('.txt')) return text;
  return JSON.parse(text);
}
