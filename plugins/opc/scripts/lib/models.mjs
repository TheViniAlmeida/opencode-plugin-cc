// Model catalog, ID parsing, aliases and normalization (spec §3.2 "IDs de modelo", §6).
import { UsageError } from './opc-error.mjs';

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

export function globToRegExp(glob) {
  const body = String(glob).split('*').map((part) => part.replace(REGEX_SPECIALS, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

export function matchesAny(value, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  return globs.some((glob) => globToRegExp(glob).test(String(value)));
}

export function parseFullId(full) {
  const text = String(full ?? '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return { providerID: null, modelID: text };
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

export function buildCatalog(providerResponse) {
  const all = Array.isArray(providerResponse?.all) ? providerResponse.all : [];
  const connected = new Set(Array.isArray(providerResponse?.connected) ? providerResponse.connected : []);
  const defaults = providerResponse?.default && typeof providerResponse.default === 'object' ? providerResponse.default : {};
  const models = [];
  const byFull = new Map();
  const providers = [];
  for (const provider of all) {
    const entries = Object.values(provider.models ?? {});
    providers.push({
      id: provider.id,
      name: provider.name ?? provider.id,
      source: provider.source ?? null,
      connected: connected.has(provider.id),
      modelCount: entries.length,
      defaultModel: defaults[provider.id] ? `${provider.id}/${defaults[provider.id]}` : null,
    });
    for (const m of entries) {
      const modelID = m.id;
      const full = `${provider.id}/${modelID}`;
      const entry = {
        providerID: provider.id,
        modelID,
        full,
        name: m.name ?? modelID,
        family: m.family ?? null,
        status: m.status ?? null,
        releaseDate: m.release_date ?? null,
        variants: Object.keys(m.variants ?? {}),
        limit: { context: m.limit?.context ?? null, output: m.limit?.output ?? null },
        cost: { input: m.cost?.input ?? null, output: m.cost?.output ?? null },
        reasoning: Boolean(m.capabilities?.reasoning),
        toolcall: Boolean(m.capabilities?.toolcall),
        connected: connected.has(provider.id),
      };
      models.push(entry);
      byFull.set(full, entry);
    }
  }
  models.sort((a, b) => a.full.localeCompare(b.full));
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { connected, models, byFull, providers, defaults };
}

export function expandAlias(value, aliases = {}) {
  if (typeof value !== 'string') return value;
  const key = value.trim();
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, key) && typeof aliases[key] === 'string') return aliases[key];
  return key;
}

function usable(catalog, full) {
  const entry = catalog.byFull.get(full);
  return entry && catalog.connected.has(entry.providerID) ? entry : null;
}

function suggestionsFor(catalog, text) {
  const needle = text.toLowerCase().split('/').pop();
  return catalog.models
    .filter((m) => m.connected && m.full.toLowerCase().includes(needle))
    .slice(0, 5)
    .map((m) => m.full);
}

function modelEcho(value) {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function normalizeModelId(input, { catalog, defaultProvider = null, aliases = {}, fullOnly = false } = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new UsageError('UNKNOWN_MODEL', 'identificador de modelo vazio');
  let text = raw;
  let forceFull = fullOnly;
  if (text.startsWith('=')) {
    text = text.slice(1);
    forceFull = true;
  }
  const expanded = expandAlias(text, aliases);
  if (expanded !== text) forceFull = true; // alias targets are stored as full IDs
  const { providerID } = parseFullId(expanded);
  const fullReading = providerID && catalog.connected.has(providerID) ? usable(catalog, expanded) : null;
  const shortReading = !forceFull && defaultProvider && catalog.connected.has(defaultProvider)
    ? usable(catalog, `${defaultProvider}/${expanded}`)
    : null;
  if (fullReading && shortReading) {
    throw new UsageError('AMBIGUOUS_MODEL',
      `o modelo "${modelEcho(raw)}" é ambíguo: "${fullReading.full}" ou "${shortReading.full}". Use "=${fullReading.full}" ou "${shortReading.full}".`,
      { details: { inputPreview: modelEcho(raw), candidates: [fullReading.full, shortReading.full] } });
  }
  const hit = fullReading ?? shortReading;
  if (hit) return { providerID: hit.providerID, modelID: hit.modelID, full: hit.full, entry: hit };
  const known = providerID ? catalog.byFull.get(expanded) : null;
  const reason = known && !catalog.connected.has(known.providerID)
    ? `o provider "${known.providerID}" não está conectado (execute: opencode auth login)`
    : 'não encontrado em /provider';
  throw new UsageError('UNKNOWN_MODEL', `modelo desconhecido "${modelEcho(raw)}": ${reason}`,
    { details: { inputPreview: modelEcho(raw), suggestions: suggestionsFor(catalog, expanded) } });
}

export function resolveModelRef(value, { catalog, defaultProvider = null, aliases = {}, allowClaude = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (allowClaude && text === 'claude') return { kind: 'claude', value: 'claude' };
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, text)) {
    const target = normalizeModelId(aliases[text], { catalog, aliases: {}, fullOnly: true });
    return { kind: 'alias', value: text, full: target.full };
  }
  const model = normalizeModelId(text, { catalog, defaultProvider, aliases: {} });
  return { kind: 'model', value: model.full, full: model.full };
}

export function validateVariant(entry, variant) {
  if (variant === null || variant === undefined || variant === '') return null;
  if (!entry.variants.includes(variant)) {
    throw new UsageError('UNKNOWN_VARIANT',
      `a variante "${modelEcho(String(variant))}" não é válida para ${entry.full} (válidas: ${entry.variants.join(', ') || 'nenhuma'})`,
      { details: { model: entry.full, variantPreview: modelEcho(String(variant)), valid: entry.variants } });
  }
  return variant;
}

export function searchModels(catalog, query, { providerID = null, connectedOnly = true, limit = 20 } = {}) {
  const text = String(query ?? '').trim();
  const pool = catalog.models.filter((m) => (!connectedOnly || m.connected) && (!providerID || m.providerID === providerID));
  let hits;
  if (text.includes('*')) {
    const re = globToRegExp(text);
    hits = pool.filter((m) => re.test(m.full) || re.test(m.modelID));
  } else {
    const needle = text.toLowerCase();
    hits = pool.filter((m) => m.full.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }
  return hits.slice(0, limit);
}
