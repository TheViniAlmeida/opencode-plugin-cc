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

export function retryExceedsCap(status, fallbackCfg = {}, now = Date.now()) {
  const maxRetries = fallbackCfg.maxProviderRetries ?? 3;
  const maxWaitSec = fallbackCfg.maxRetryWaitSec ?? 60;
  if (typeof status?.attempt === 'number' && status.attempt > maxRetries) return true;
  if (typeof status?.next === 'number' && (status.next - now) / 1000 > maxWaitSec) return true;
  return false;
}
