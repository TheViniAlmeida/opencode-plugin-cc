// Shape recording and diffing used by tests/live/contract.mjs (kept import-safe for unit tests).

// Probe registry read by tests/live/contract.mjs (the single contract runner). Later phases APPEND entries here
// (explicit "Modify" steps) for the GET endpoints / passive SSE events they start consuming:
// { name, method: 'GET', path, used: [dotted fields opc reads], optionalUsed?: [fields read only if present] }.
export const PROBES = [
  { name: 'health', method: 'GET', path: '/global/health', used: ['healthy', 'version'] },
  { name: 'agent', method: 'GET', path: '/agent', used: ['[].name', '[].mode', '[].permission', '[].options'] },
  { name: 'config', method: 'GET', path: '/config', used: [], optionalUsed: ['model', 'small_model', 'share', 'autoshare', 'mcp'] },
  { name: 'session.status', method: 'GET', path: '/session/status', used: [] },
  { name: 'permission', method: 'GET', path: '/permission', used: [] },
  { name: 'question', method: 'GET', path: '/question', used: [] },
];
export const EVENT_TYPES = ['server.connected', 'server.heartbeat'];

// Maps whose keys are user data (provider names, MCP names…): only the value shape is recorded.
export const MAP_PATHS = new Set([
  'config.agent', 'config.mcp', 'config.provider', 'config.command', 'config.mode', 'config.lsp', 'config.formatter',
  'config.permission', 'session.status',
]);

export function toolAttempted(tools, asked, tool) {
  return tools.some((part) => part.tool === tool && ['error', 'completed'].includes(part.status))
    || asked.some((event) => event.permission === tool);
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
  if (Array.isArray(value)) return value.length === 0 ? ['empty'] : [shapeOf(value[0], `${at}[]`)];
  if (typeof value === 'object') {
    if (MAP_PATHS.has(at)) {
      const first = Object.values(value)[0];
      return { '*': first === undefined ? 'empty' : shapeOf(first, `${at}.*`) };
    }
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], at ? `${at}.${k}` : k)]));
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
