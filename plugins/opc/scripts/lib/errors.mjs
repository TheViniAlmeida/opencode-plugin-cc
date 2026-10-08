// Classification of OpenCode errors (spec §7.1).
import { safeOutputText } from './redact.mjs';
export function classifyError(error, { toolsRan = false, candidateHasLargerContext = false } = {}) {
  const errorType = error?.type ?? (typeof error?.name === 'string' && error.name ? error.name : 'UnknownError');
  const fixed = {
    Timeout: 'O turno excedeu o tempo limite.',
    RetryCapExceeded: 'Limite de novas tentativas excedido.',
    'provider.no-route': 'Modelo indisponível.',
    'provider.auth': 'Falha de autenticação do provedor.',
    'provider.rate-limit': 'Limite de requisições do provedor atingido.',
    'provider.transport': 'Falha de transporte do provedor.',
    aborted: 'Turno cancelado.',
    'permission.rejected': 'Permissão recusada.',
    'execution.failed': 'A execução falhou.',
    APIError: 'Falha na API do provedor.',
    BadRequest: 'A requisição foi rejeitada.',
    ContextOverflowError: 'O contexto do modelo foi excedido.',
  };
  const providerDetail = ['provider.no-route', 'provider.auth'].includes(errorType) && typeof (error?.data?.message ?? error?.message) === 'string'
    ? safeOutputText(error.data?.message ?? error.message).replace(/[\r\n]+/g, ' ').slice(0, 500).trim()
    : '';
  const message = providerDetail ? `${fixed[errorType]} ${providerDetail}` : fixed[errorType] ?? 'Erro do OpenCode.';
  const as = (errorClass) => ({ errorClass, errorType, message });
  if (Number(error?.status ?? error?.statusCode ?? error?.data?.statusCode ?? error?.data?.status) === 429) {
    return { errorClass: 'recoverable', errorType, message: 'Limite de requisições do provedor atingido.' };
  }
  switch (errorType) {
    case 'APIError': {
      const data = error.data ?? {};
      return as(data.isRetryable === true || data.statusCode === 404 ? 'recoverable' : 'fatal');
    }
    case 'RetryCapExceeded':
    case 'Timeout':
    case 'provider.rate-limit':
    case 'provider.transport':
      return as('recoverable');
    case 'provider.no-route':
    case 'aborted':
      return as('fatal');
    case 'permission.rejected':
      return as(toolsRan ? 'recoverable' : 'fatal');
    case 'ContextOverflowError':
      return as(candidateHasLargerContext ? 'recoverable' : 'fatal');
    default:
      // ProviderAuthError, MessageAbortedError, ContentFilterError, MessageOutputLengthError,
      // UnknownError, BadRequest, ServerLost, Cancelled and anything unknown.
      return as('fatal');
  }
}

export const RETRY_CAP_ERROR_NAME = 'RetryCapExceeded';

// `next` é o instante agendado da próxima tentativa, em epoch ms (V2: `at`).
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
  const attempt = Number(status?.attempt);
  const message = `Limite de tentativas do OpenCode excedido (tentativa ${Number.isInteger(attempt) ? attempt : '?'}${wait}).`;
  return { name: RETRY_CAP_ERROR_NAME, data: { message } };
}
