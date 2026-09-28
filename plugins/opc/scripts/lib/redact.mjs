// Secret redaction for every JSON output and log line (spec §3.1).
import { isSecretLikeSetting } from './secret-settings.mjs';

export const SECRET_KEYS = Object.freeze([
  'key', 'apiKey', 'apikey', 'password', 'authorization', 'headers', 'responseHeaders', 'token', 'secret',
]);

const MASK = '***';
const MIN_SECRET_LENGTH = 8;
const registered = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) registered.add(value);
}

export function redactText(text) {
  if (typeof text !== 'string' || registered.size === 0) return text;
  let out = text;
  const secrets = [...registered].sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join(MASK);
  return out;
}

function maskMatches(text, pattern) {
  return text.replace(pattern, '***');
}

export function maskSecretPatterns(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  // Provider tokens, GitHub/GitLab tokens, and common cloud credentials.
  out = maskMatches(out, /\b(?:sk-(?:proj-|ant-)?|gh[pso]_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_-]{8,}/g);
  out = maskMatches(out, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g);
  out = maskMatches(out, /\bAIza[A-Za-z0-9_-]{35}\b/g);
  out = maskMatches(out, /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
  out = maskMatches(out, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g);
  out = maskMatches(out, /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi);
  const maskAssignment = (match, prefix, key, raw) => {
    const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
    const value = quote ? raw.slice(1, -1) : raw;
    return isSecretLikeSetting(key) && value.length >= MIN_SECRET_LENGTH && !/\s/.test(value) && !value.startsWith('-')
      ? `${prefix}${quote}${MASK}${quote}` : match;
  };
  // A colon is an assignment only for a quoted JSON-like key and value, never prose.
  out = out.replace(/(?<![A-Za-z0-9_.-])("([A-Za-z0-9_.-]+)"\s*:\s*)("(?:\\.|[^"\\])*")/g, maskAssignment);
  out = out.replace(/(?<![A-Za-z0-9_.-])(([A-Za-z0-9_.-]+)\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/g, maskAssignment);
  return out;
}

export function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return {
        name: redactText(value.name),
        code: typeof value.code === 'string' ? redactText(value.code) : value.code,
        message: redactText(value.message),
      };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const secret = isSecretLikeSetting(k) || (k === 'value' && typeof value.setting === 'string' && isSecretLikeSetting(value.setting));
      out[k] = secret && v !== null && v !== undefined ? MASK : redact(v);
    }
    return out;
  }
  return value;
}

// Free model/request text needs pattern masking as well as registered-secret redaction.
export function safeOutputText(value) {
  return redactText(maskSecretPatterns(String(value ?? '')));
}

export function redactOutput(value) {
  const safe = redact(value);
  const visit = (item) => {
    if (typeof item === 'string') return safeOutputText(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [safeOutputText(key), visit(val)]));
    return item;
  };
  return visit(safe);
}

// A turn also contains opc status/error messages; mask only its model/repository fields.
export function redactTurnOutput(value) {
  const safe = redact(value);
  if (!safe || typeof safe !== 'object') return safe;
  for (const field of ['finalText', 'structured', 'touchedFiles']) {
    if (Object.hasOwn(safe, field)) safe[field] = redactOutput(safe[field]);
  }
  return safe;
}
