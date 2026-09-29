// Classification of OpenCode errors (spec §7.1).
import { redactText } from './redact.mjs';

const MAX_MESSAGE_CHARS = 2000;

function messageOf(error) {
  let raw;
  if (typeof error === 'string') raw = error;
  else {
    raw = error?.data?.message ?? error?.message;
    if (raw === undefined || raw === null) {
      try {
        raw = JSON.stringify(error ?? null);
      } catch {
        raw = error?.code ?? error?.name ?? 'erro desconhecido';
      }
    }
  }
  const text = redactText(String(raw));
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

export function classifyError(error, { toolsRan = false, candidateHasLargerContext = false } = {}) {
  const errorType = typeof error?.name === 'string' && error.name ? error.name : 'UnknownError';
  const message = messageOf(error);
  const as = (errorClass) => ({ errorClass, errorType, message });
  switch (errorType) {
    case 'APIError': {
      const data = error.data ?? {};
      return as(data.isRetryable === true || data.statusCode === 404 ? 'recoverable' : 'fatal');
    }
    case 'RetryCapExceeded':
    case 'Timeout':
      return as('recoverable');
    case 'StructuredOutputError':
      return as(toolsRan ? 'fatal' : 'recoverable');
    case 'ContextOverflowError':
      return as(candidateHasLargerContext ? 'recoverable' : 'fatal');
    default:
      // ProviderAuthError, MessageAbortedError, ContentFilterError, MessageOutputLengthError,
      // UnknownError, BadRequest, ServerLost, Cancelled and anything unknown.
      return as('fatal');
  }
}

export const RETRY_CAP_ERROR_NAME = 'RetryCapExceeded';

// `next` é o instante agendado da próxima tentativa, em epoch ms (OpenCode 1.18.32: `next: data.at`).
export function retryExceedsCap(status, fallbackCfg = {}, now = Date.now()) {
  if (!status || (status.type !== undefined && status.type !== 'retry')) return false;
  const maxRetries = Number(fallbackCfg?.maxProviderRetries ?? 3);
  const maxWaitSec = Number(fallbackCfg?.maxRetryWaitSec ?? 60);
  if (Number(status.attempt) > maxRetries) return true;
  const next = Number(status.next);
  if (!Number.isFinite(next)) return false;
  return next - now > maxWaitSec * 1000;
}

export function retryCapError(status, now = Date.now()) {
  const next = Number(status?.next);
  const wait = Number.isFinite(next) ? `, próxima em ${Math.max(0, Math.round((next - now) / 1000))}s` : '';
  const message = `teto de retries do OpenCode excedido (tentativa ${status?.attempt ?? '?'}${wait}): ${status?.message ?? ''}`.trim();
  return { name: RETRY_CAP_ERROR_NAME, data: { message } };
}
