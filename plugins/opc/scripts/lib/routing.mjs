// Model, agent and variant resolution (spec §6). Fallback execution is F4a; here we only
// compute the candidate list and whether it is eligible for fallback.
import { OpcError, PolicyError, UsageError } from './opc-error.mjs';
import { expandAlias, normalizeModelId, parseFullId, validateVariant } from './models.mjs';
import { assertAgentUsable, evaluate } from './policy.mjs';

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

function checkCandidate(value, { catalog, config }) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const expanded = expandAlias(typeof raw === 'string' && raw.startsWith('=') ? raw.slice(1) : raw, config.aliases ?? {});
  const { providerID, modelID } = parseFullId(expanded);
  const known = providerID ? catalog.byFull.get(`${providerID}/${modelID}`) : null;
  const parsed = known && !catalog.connected.has(providerID)
    ? { providerID, modelID, full: known.full, entry: known }
    : normalizeModelId(value, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
  const policy = config.policy ?? {};
  for (const [kind, subject] of [['provider', parsed.providerID], ['model', parsed.full]]) {
    const verdict = evaluate(kind, subject, policy);
    if (!verdict.allowed) {
      throw new PolicyError('POLICY_DENIED', `${kind === 'provider' ? 'provider' : 'modelo'} ${echo(subject)} negado pela política${verdict.rule ? ` (regra: ${echo(verdict.rule)})` : ''}`);
    }
  }
  if (!catalog.connected.has(parsed.providerID)) {
    throw new UsageError('PROVIDER_NOT_CONNECTED', `provider ${echo(parsed.providerID)} não está conectado (execute: opencode auth login)`);
  }
  return parsed;
}

export function resolveCandidates({ kind, flags = {}, config = {}, catalog, opencodeConfig = null }) {
  const { source, values } = pickLevel({ kind, flags, config, opencodeConfig });
  if (!LIST_SOURCES.has(source)) {
    const candidate = checkCandidate(values[0], { catalog, config });
    return { candidates: [{ ...candidate, source }], warnings: [], fallbackEligible: false };
  }
  const candidates = [];
  const warnings = [];
  const problems = [];
  let denied = 0;
  for (const value of values) {
    try {
      const candidate = checkCandidate(value, { catalog, config });
      if (!candidates.some((c) => c.full === candidate.full)) candidates.push({ ...candidate, source });
    } catch (err) {
      if (!(err instanceof OpcError)) throw err;
      if (err instanceof PolicyError) denied += 1;
      problems.push(`${echo(value)}: ${err.message}`);
      warnings.push(`ignorado ${echo(value)}: ${err.message}`);
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
