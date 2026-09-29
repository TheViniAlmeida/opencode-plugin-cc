// Model, agent and variant resolution (spec §6). Fallback execution is F4a; here we only
// compute the candidate list and whether it is eligible for fallback.
import { OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { configModelLabel, expandAlias, normalizeModelId, parseFullId, validateVariant } from './models.mjs';
import { assertAgentUsable, evaluate } from './policy.mjs';
import { safeOutputText } from './redact.mjs';

const LIST_SOURCES = new Set(['tier', 'route']);
const echo = (value) => {
  const text = String(value ?? '');
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
};

export function kindSpecificModel(kind, config = {}) {
  const pick = (value) => (typeof value === 'string' && value && value !== 'claude' ? value : null);
  switch (kind) {
    case 'review':
    case 'adversarial-review':
      return pick(config.reviewModel);
    case 'stop-gate':
      return pick(config.stopGate?.model);
    case 'planner':
      return pick(config.orchestrate?.planner);
    case 'synthesizer':
      return pick(config.orchestrate?.synthesizer);
    case 'judge':
      return pick(config.conclave?.judge);
    default:
      return null; // task, ask, plan, summarize (summarize takes --model)
  }
}

function pickLevel({ kind, flags, config, opencodeConfig }) {
  if (flags.model) return { source: 'flag', values: [flags.model] };
  if (flags.tier) {
    const list = config.routing?.tiers?.[flags.tier];
    if (!Array.isArray(list) || list.length === 0) {
      throw new UsageError('UNKNOWN_TIER', `routing.tiers.${echo(flags.tier)} não está configurado`);
    }
    return { source: 'tier', values: list };
  }
  const specific = kindSpecificModel(kind, config);
  if (specific) return { source: 'kind', values: [specific] };
  const route = config.routing?.tasks?.[kind];
  if (Array.isArray(route) && route.length > 0) return { source: 'route', values: route };
  if (typeof config.defaultModel === 'string' && config.defaultModel) return { source: 'default', values: [config.defaultModel] };
  if (typeof opencodeConfig?.model === 'string' && opencodeConfig.model) return { source: 'opencode', values: [opencodeConfig.model] };
  throw new UsageError('NO_MODEL', 'nenhum modelo foi resolvido (sem --model, --tier, rota, defaultModel ou modelo padrão do OpenCode); informe --model <provider>/<model>');
}

function checkCandidate(value, { catalog, config, fromConfig = false }) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const expanded = expandAlias(typeof raw === 'string' && raw.startsWith('=') ? raw.slice(1) : raw, config.aliases ?? {});
  const { providerID, modelID } = parseFullId(expanded);
  const known = providerID ? catalog.byFull.get(`${providerID}/${modelID}`) : null;
  const parsed = known && !catalog.connected.has(providerID)
    ? { providerID, modelID, full: known.full, entry: known }
    : normalizeModelId(value, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {}, fromConfig });
  const policy = config.policy ?? {};
  for (const [kind, subject] of [['provider', parsed.providerID], ['model', parsed.full]]) {
    const verdict = evaluate(kind, subject, policy);
    if (!verdict.allowed) {
      throw new PolicyError('POLICY_DENIED', `${kind === 'provider' ? 'provider' : 'modelo'} ${safeOutputText(subject)} negado pela política${verdict.rule ? ` (regra: ${safeOutputText(verdict.rule)})` : ''}`);
    }
  }
  if (!catalog.connected.has(parsed.providerID)) {
    throw new UsageError('PROVIDER_NOT_CONNECTED', `provider ${safeOutputText(parsed.providerID)} não está conectado (execute: opencode auth login)`);
  }
  return parsed;
}

export function resolveCandidates({ kind, flags = {}, config = {}, catalog, opencodeConfig = null }) {
  assertTier(flags?.tier, config);
  const { source, values } = pickLevel({ kind, flags, config, opencodeConfig });
  if (!LIST_SOURCES.has(source)) {
    const candidate = checkCandidate(values[0], { catalog, config, fromConfig: source !== 'flag' });
    return { candidates: [{ ...candidate, source }], warnings: [], fallbackEligible: false };
  }
  const candidates = [];
  const warnings = [];
  const problems = [];
  let denied = 0;
  for (const value of values) {
    try {
      const candidate = checkCandidate(value, { catalog, config, fromConfig: true });
      if (!candidates.some((c) => c.full === candidate.full)) candidates.push({ ...candidate, source });
    } catch (err) {
      if (!(err instanceof OpcError)) throw err;
      if (err instanceof PolicyError) denied += 1;
      problems.push(`${configModelLabel(value)}: ${err.message}`);
      warnings.push(`ignorado ${configModelLabel(value)}: ${err.message}`);
    }
  }
  if (candidates.length === 0) {
    const where = source === 'tier' ? `routing.tiers.${echo(flags.tier)}` : `routing.tasks.${kind}`;
    const message = `nenhum modelo utilizável em ${where}:\n- ${problems.join('\n- ')}`;
    if (denied === values.length) throw new PolicyError('POLICY_DENIED', message);
    throw new UsageError('NO_VALID_CANDIDATE', message);
  }
  return { candidates, warnings, fallbackEligible: candidates.length > 1 };
}

// ---- F4a: tiers ---------------------------------------------------------------

export const TIERS = Object.freeze(['light', 'heavy']);

export function assertTier(tier, config) {
  if (tier === undefined || tier === null || tier === '') return;
  if (!TIERS.includes(tier)) {
    throw new UsageError('INVALID_TIER', `--tier deve ser um de: ${TIERS.join(', ')} (recebido: "${echo(tier)}")`);
  }
  const list = config?.routing?.tiers?.[tier];
  if (!Array.isArray(list) || list.length === 0) {
    throw new UsageError('EMPTY_TIER', `routing.tiers.${tier} está vazio; configure com: opc config add routing.tiers.${tier} <modelo>`);
  }
}

// ---- F4a: campos de roteamento gravados no request do job --------------------

export function routingFields(resolution, { resume = false, catalog = null, warningsReported = false } = {}) {
  const { candidates, warnings = [], fallbackEligible } = resolution;
  return {
    candidates: candidates.map(({ providerID, modelID, full, source }) => {
      const limit = catalog?.byFull?.get?.(full)?.limit?.context;
      return { providerID, modelID, full, source, contextLimit: typeof limit === 'number' ? limit : null };
    }),
    fallbackEligible: fallbackEligible === true && !resume,
    routingWarnings: [...warnings],
    routingWarningsReported: warningsReported,
  };
}

export function attemptRequest(base, candidate, { messageId }) {
  return {
    ...base,
    model: { providerID: candidate.providerID, modelID: candidate.modelID },
    messageID: messageId(),
  };
}

// ---- F4a: backoff -------------------------------------------------------------

export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 4000, 8000]);

export function backoffFromEnv(env = process.env) {
  const raw = env.OPC_FALLBACK_BACKOFF_MS;
  if (raw === undefined || raw === '') return [...DEFAULT_BACKOFF_MS];
  const parts = String(raw).split(',').map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return [...DEFAULT_BACKOFF_MS];
  return parts;
}

export function backoffDelay(backoffMs, retryIndex) {
  if (!Array.isArray(backoffMs) || backoffMs.length === 0) return 0;
  return backoffMs[Math.min(retryIndex, backoffMs.length - 1)];
}

export function abortableSleep(ms, signal, isCancelled = () => false) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (value, error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(false);
    const deadline = performance.now() + ms;
    const poll = () => {
      try {
        if (signal?.aborted || isCancelled()) return finish(false);
        const remaining = deadline - performance.now();
        if (remaining <= 0) return finish(true);
        timer = setTimeout(poll, Math.min(100, remaining));
      } catch (error) { finish(false, error); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    poll();
  });
}

// Variant rules live in F1 validateVariant; agent policy (name + pinned provider/model) in F1
// assertAgentUsable. Here we only add existence and the "cannot drive a session" mode check.
export function validateSelection({ candidate, variant = null, agentName = null, agents = [], catalog, policy = {} }) {
  const entry = catalog.byFull.get(candidate.full) ?? { full: candidate.full, variants: [] };
  const checkedVariant = validateVariant(entry, variant);
  if (agentName) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) throw new UsageError('UNKNOWN_AGENT', `agente desconhecido "${echo(agentName)}" (consulte /opc:agents)`);
    assertAgentUsable(agent, policy);
    if (agent.mode === 'subagent') {
      throw new UsageError('AGENT_MODE', `o agente "${echo(agentName)}" é exclusivo para subagentes e não pode conduzir uma sessão`);
    }
  }
  return { variant: checkedVariant, agent: agentName || null };
}

// ---- F2b: the single model a turn uses (no fallback until F4a) ----
import { buildCatalog } from './models.mjs';

export async function resolveTurnModel({ api, kind, flags = {}, config }) {
  const [providerResponse, opencodeConfig] = await Promise.all([api.providers(), api.getConfig()]);
  const catalog = buildCatalog(providerResponse);
  const resolution = resolveCandidates({ kind, flags: { model: flags.model, tier: flags.tier }, config, catalog, opencodeConfig });
  const chosen = resolution.candidates[0];
  const selection = validateSelection({ candidate: chosen, variant: flags.variant ?? null, catalog, policy: config?.policy ?? {} });
  return {
    model: { providerID: chosen.providerID, modelID: chosen.modelID },
    full: chosen.full,
    variant: selection.variant,
    warnings: resolution.warnings ?? [],
    resolution,
    catalog,
    opencodeConfig,
  };
}

// ---- F4a: laço de fallback -----------------------------------------------------------

function isServerLost(result) {
  return result.errorCode === 'server_lost' || result.errorType === 'server_lost';
}

function largerContextCandidates(queue, current, contextLimitOf) {
  const base = contextLimitOf(current);
  if (typeof base !== 'number') return [];
  return queue.filter((candidate) => {
    const limit = contextLimitOf(candidate);
    return typeof limit === 'number' && limit > base;
  });
}

export async function runWithFallback({
  candidates,
  fallbackEligible,
  fallbackCfg = {},
  write = false,
  runAttempt,
  sleep = abortableSleep,
  backoffMs = DEFAULT_BACKOFF_MS,
  contextLimitOf = () => null,
  signal,
  cancelRequestedAt = null,
  job = null,
  isCancelled = () => false,
  now = () => new Date().toISOString(),
  onAttemptStart = async () => {},
  onAttemptEnd = async () => {},
  onBackoff = async () => {},
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new UsageError('NO_CANDIDATES', 'runWithFallback: a lista de candidatos está vazia');
  }
  if (typeof runAttempt !== 'function') throw new TypeError('runWithFallback: runAttempt é obrigatório');
  const cancelPending = () => Boolean(
    (typeof cancelRequestedAt === 'function' ? cancelRequestedAt() : cancelRequestedAt)
    || job?.cancelRequestedAt
    || isCancelled(),
  );
  const enabled = fallbackEligible === true && fallbackCfg.enabled !== false;
  const configuredMax = Number(fallbackCfg.maxAttempts ?? 3);
  const maxAttempts = enabled ? (Number.isFinite(configuredMax) ? Math.max(1, Math.floor(configuredMax)) : 3) : 1;
  let queue = candidates.slice(1);
  let current = candidates[0];
  const attempts = [];
  let result = null;
  let stopReason = null;

  while (current) {
    if (signal?.aborted || cancelPending()) { stopReason = 'cancelled'; break; }
    const index = attempts.length;
    const startedAt = now();
    await onAttemptStart(current, index);
    if (signal?.aborted || cancelPending()) { stopReason = 'cancelled'; break; }
    result = await runAttempt(current, index);
    const record = {
      model: current.full,
      sessionID: result.sessionID ?? null,
      status: result.status,
      errorClass: result.errorClass ?? null,
      errorType: result.errorType ?? null,
      startedAt,
      endedAt: now(),
    };
    attempts.push(record);
    await onAttemptEnd(record, result, index);

    if (result.status === 'completed') { stopReason = 'completed'; break; }
    if (result.status === 'cancelled' || signal?.aborted || cancelPending()) { stopReason = 'cancelled'; break; }
    if (isServerLost(result)) { stopReason = 'server-lost'; break; }
    if (!enabled) { stopReason = 'not-eligible'; break; }

    let recoverable = result.errorClass === 'recoverable';
    if (result.errorType === 'ContextOverflowError') {
      const larger = largerContextCandidates(queue, current, contextLimitOf);
      recoverable = larger.length > 0;
      if (recoverable) queue = larger;
    }
    if (!recoverable) { stopReason = 'fatal'; break; }
    if (write && result.toolsRan) { stopReason = 'write-tools-ran'; break; }
    if (attempts.length >= maxAttempts) { stopReason = 'max-attempts'; break; }
    if (queue.length === 0) { stopReason = 'exhausted'; break; }

    const next = queue.shift();
    const delay = backoffDelay(backoffMs, index);
    await onBackoff(delay, next, record);
    if (signal?.aborted || cancelPending()) { stopReason = 'cancelled'; break; }
    const slept = await sleep(delay, signal, cancelPending);
    if (!slept || signal?.aborted || cancelPending()) { stopReason = 'cancelled'; break; }
    current = next;
  }

  return { result, attempts, stopReason, fallbackUsed: attempts.length > 1 };
}

export function describeStop({ stopReason, result, attempts }) {
  if (stopReason === 'write-tools-ran') {
    const files = result.touchedFiles?.length ? result.touchedFiles.map(safeOutputText).join(', ') : '(nenhum registrado)';
    const tools = result.toolNames?.length ? result.toolNames.map(safeOutputText).join(', ') : '(desconhecidas)';
    return {
      errorCode: 'WRITE_NO_FALLBACK',
      errorMessage: `${safeOutputText(result.errorType ?? 'Erro')}: ${safeOutputText(result.errorMessage ?? 'o turno falhou')}. Sem fallback: este turno --write já executou ferramentas (risco de efeito duplicado). Arquivos tocados: ${files}. Ferramentas executadas: ${tools}.`,
    };
  }
  if ((stopReason === 'max-attempts' || stopReason === 'exhausted') && attempts.length > 1) {
    const trail = attempts.map((attempt, index) => `${index + 1}) ${safeOutputText(attempt.model)}: ${safeOutputText(attempt.errorType ?? attempt.status)}`).join('; ');
    return {
      errorCode: 'FALLBACK_EXHAUSTED',
      errorMessage: `Todas as ${attempts.length} tentativas falharam (${trail}). Último erro: ${safeOutputText(result.errorMessage ?? result.errorType ?? 'desconhecido')}`,
    };
  }
  return null;
}
