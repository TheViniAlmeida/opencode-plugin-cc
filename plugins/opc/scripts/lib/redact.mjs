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
