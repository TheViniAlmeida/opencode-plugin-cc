// Conclave: composition, anonymization, rounds, review clustering and synthesis package.
// Composes runner turns through injected deps; never talks HTTP directly (spec §3.1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpcError, ExitCode } from './opc-error.mjs';
import { normalizeModelId } from './models.mjs';
import { evaluate } from './policy.mjs';
// Single home of the prompt helpers (F2b); conclave never redefines them.
import { fillTemplate, loadPrompt, projectContextBlock } from './prompts.mjs';

export const CONCLAVE_MODES = Object.freeze(['opinion', 'review', 'debate']);
export const LABEL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const REDACTED_NAME = '[redacted]';
export const PEER_RESPONSE_MAX_CHARS = 16 * 1024;
export const RAW_TEXT_MAX_CHARS = 4 * 1024;
export const CLUSTER_LINE_GAP = 3;
export const CLUSTER_TITLE_THRESHOLD = 0.3;
export const SEVERITY_ORDER = Object.freeze(['low', 'medium', 'high', 'critical']);

const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Schema validation (subset of JSON Schema used by opc schemas)
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function walkSchema(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push({ path: at, message: `esperado ${types.join('|')}, recebido ${typeOf(value)}` });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push({ path: at, message: 'o valor deve corresponder a uma das opções permitidas' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `deve ser >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `deve ser <= ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path: at, message: `deve ter comprimento >= ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path: at, message: `deve ter comprimento <= ${schema.maxLength}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `deve ter >= ${schema.minItems} itens` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `deve ter <= ${schema.maxItems} itens` });
    if (schema.items) value.forEach((item, i) => walkSchema(item, schema.items, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: `${at}.${key}`, message: 'é obrigatório' });
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) walkSchema(value[key], sub, `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push({ path: `${at}.${key}`, message: 'não é permitido' });
      }
    }
  }
}

export function validateSchema(value, schema) {
  const errors = [];
  walkSchema(value, schema, '$', errors);
  return errors;
}

function stripMeta(schema) {
  const copy = structuredClone(schema);
  delete copy.$schema;
  delete copy.$defs;
  return copy;
}

export function buildMemberSchema(memberSchemaFile) {
  return stripMeta(memberSchemaFile);
}

export function buildDebateSchema(memberSchemaFile, peerLabels = []) {
  const extension = memberSchemaFile?.$defs?.debateExtension;
  if (!extension) throw new OpcError('CONCLAVE_SCHEMA', 'o schema conclave-member não contém $defs.debateExtension');
  const schema = stripMeta(memberSchemaFile);
  const extra = structuredClone(extension.properties);
  if (peerLabels.length > 0) extra.critiques.items.properties.target.enum = [...peerLabels];
  schema.title = 'ConclaveDebate';
  schema.properties = { ...schema.properties, ...extra };
  schema.required = [...schema.required, ...extension.required];
  return schema;
}

export function buildSynthesisSchema(synthesisSchemaFile, labels = []) {
  const schema = stripMeta(synthesisSchemaFile);
  if (labels.length > 0) {
    schema.properties.disagreements.items.properties.positions.items.properties.members.items.enum = [...labels];
    schema.properties.minority_reports.items.properties.members.items.enum = [...labels];
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Assets (fillTemplate and projectContextBlock come from lib/prompts.mjs, F2b)
// ---------------------------------------------------------------------------

export function loadConclaveAssets(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf8');
  const json = (...parts) => JSON.parse(read(...parts));
  return {
    prompts: {
      member: read('prompts', 'conclave-member.md'),
      debate: read('prompts', 'conclave-debate.md'),
      judge: read('prompts', 'conclave-judge.md'),
      review: loadPrompt('review', { dir: path.join(pluginRoot, 'prompts') }),
    },
    schemas: {
      member: json('schemas', 'conclave-member.schema.json'),
      synthesis: json('schemas', 'conclave-synthesis.schema.json'),
      review: json('schemas', 'review-output.schema.json'),
    },
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function usage(code, message, details) {
  return new OpcError(code, message, { exitCode: ExitCode.USAGE, details });
}

function preview(value) {
  const text = String(value ?? '');
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

function checkRoundsValue(value, source) {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw usage('CONCLAVE_INVALID_ROUNDS', `${source} deve ser um inteiro entre 1 e 3 (recebido ${preview(value)})`);
  }
}

function resolveRounds(mode, flagRounds, configRounds) {
  if (flagRounds != null) checkRoundsValue(flagRounds, '--rounds');
  if (configRounds != null) checkRoundsValue(configRounds, 'conclave.rounds');
  if (mode === 'review') {
    if (flagRounds != null && flagRounds !== 1) throw usage('CONCLAVE_REVIEW_ROUNDS', '--mode review executa uma rodada; remova --rounds');
    return 1;
  }
  if (mode === 'debate') {
    const rounds = flagRounds ?? Math.max(2, configRounds ?? 2);
    if (rounds < 2) throw usage('CONCLAVE_DEBATE_ROUNDS', '--mode debate exige --rounds 2 ou 3');
    return rounds;
  }
  return flagRounds ?? configRounds ?? 1;
}

export function validateConclaveOptions({ mode = 'opinion', models = null, pool = null, quorum = null, rounds = null, config = {} } = {}) {
  if (!CONCLAVE_MODES.includes(mode)) throw usage('CONCLAVE_INVALID_MODE', `modo inválido "${preview(mode)}" (esperado: ${CONCLAVE_MODES.join(', ')})`);
  const hasModels = models != null;
  const hasPool = pool != null;
  if (hasModels && hasPool) throw usage('CONCLAVE_MODELS_AND_POOL', '--models e --pool são mutuamente exclusivos');
  if (hasModels && (!Array.isArray(models) || models.length === 0)) {
    throw usage('CONCLAVE_EMPTY_SELECTION', '--models exige ao menos uma entrada');
  }
  if (hasPool && String(pool).trim() === '') throw usage('CONCLAVE_EMPTY_SELECTION', '--pool exige um nome');
  if (hasPool) {
    const poolName = pool;
    if (!Array.isArray(config.conclave?.pools?.[poolName]) || config.conclave.pools[poolName].length === 0) {
      throw usage('CONCLAVE_UNKNOWN_POOL', `pool do conclave "${preview(poolName)}" não está definido; informe --models a,b`);
    }
  }
  if (hasModels) {
    const distinct = new Set(models.map((m) => String(m).trim()).filter(Boolean));
    if (distinct.size < 2) throw usage('CONCLAVE_TOO_FEW_MEMBERS', 'um conclave exige pelo menos 2 membros (--models a,b)');
  }
  if (quorum != null && (!Number.isInteger(quorum) || quorum < 2)) throw usage('CONCLAVE_INVALID_QUORUM', `--quorum deve ser um inteiro >= 2 (recebido ${preview(quorum)})`);
  return { rounds: resolveRounds(mode, rounds, config.conclave?.rounds ?? null) };
}

function policyDenial(resolved, policy) {
  const provider = evaluate('provider', resolved.providerID, policy ?? {});
  if (!provider.allowed) return `provider negado pela política (${provider.rule ?? 'policy'})`;
  const model = evaluate('model', resolved.full, policy ?? {});
  if (!model.allowed) return `modelo negado pela política (${model.rule ?? 'policy'})`;
  return null;
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function resolveJudge(value, { catalog, config, policy }) {
  if (value === 'claude') return { type: 'claude' };
  let resolved;
  try {
    resolved = normalizeModelId(value, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
  } catch (err) {
    throw usage('CONCLAVE_INVALID_JUDGE', `juiz inválido "${preview(value)}": ${err.message}`);
  }
  if (!catalog.connected.has(resolved.providerID)) throw usage('CONCLAVE_INVALID_JUDGE', `juiz inválido: o provider não está conectado`);
  const denial = policyDenial(resolved, policy);
  if (denial) throw new OpcError('POLICY_DENIED', `juiz do conclave: ${denial}`, { exitCode: ExitCode.POLICY });
  return { type: 'model', providerID: resolved.providerID, modelID: resolved.modelID, full: resolved.full };
}

export function composeMembers({
  models = null, pool = null, config = {}, catalog, policy = config.policy, quorum = null, rounds = null,
  mode = 'opinion', judge = null, allowJudgeMember = false, rng = Math.random,
} = {}) {
  const { rounds: effectiveRounds } = validateConclaveOptions({ mode, models, pool, quorum, rounds, config });
  const conclaveCfg = config.conclave ?? {};
  let entries;
  let source;
  if (models != null) {
    entries = models; source = '--models';
  } else {
    const poolName = pool ?? conclaveCfg.defaultPool ?? 'default';
    const list = conclaveCfg.pools?.[poolName];
    if (!Array.isArray(list) || list.length === 0) throw usage('CONCLAVE_UNKNOWN_POOL', `pool do conclave "${preview(poolName)}" não está definido; informe --models a,b`);
    entries = list; source = `pool:${poolName}`;
  }

  const warnings = [];
  const skipped = [];
  const accepted = [];
  const seen = new Set();
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) {
      const reason = 'a entrada está vazia ou em branco';
      skipped.push({ entry: preview(raw), reason, denied: false });
      warnings.push(`conclave: ignorando "${preview(raw)}": ${reason}`);
      continue;
    }
    let resolved;
    try {
      resolved = normalizeModelId(entry, { catalog, defaultProvider: config.defaultProvider, aliases: config.aliases ?? {} });
    } catch (err) {
      // A catalog model (e.g. behind a disconnected provider) is not user noise: show its full id.
      const shown = catalog.byFull?.has(entry) ? entry : preview(entry);
      const reason = err.message.replaceAll(entry, shown);
      skipped.push({ entry: shown, reason, denied: false });
      warnings.push(`conclave: ignorando "${shown}": ${reason}`);
      continue;
    }
    if (!catalog.connected.has(resolved.providerID)) {
      const reason = 'o provider não está conectado';
      skipped.push({ entry: resolved.full, reason, denied: false });
      warnings.push(`conclave: ignorando "${resolved.full}": ${reason}`);
      continue;
    }
    const denial = policyDenial(resolved, policy);
    if (denial) {
      skipped.push({ entry: resolved.full, reason: denial, denied: true });
      warnings.push(`conclave: ignorando "${resolved.full}": ${denial}`);
      continue;
    }
    if (seen.has(resolved.full)) {
      warnings.push(`conclave: membro duplicado "${resolved.full}" ignorado`);
      continue;
    }
    seen.add(resolved.full);
    accepted.push({ providerID: resolved.providerID, modelID: resolved.modelID, full: resolved.full, source });
  }

  const listing = skipped.map((s) => `${s.entry}: ${s.reason}`).join('; ');
  if (accepted.length === 0 && skipped.length > 0 && skipped.every((s) => s.denied)) {
    throw new OpcError('POLICY_DENIED', `conclave: todos os membros foram negados pela política (${listing})`, { exitCode: ExitCode.POLICY, details: { skipped } });
  }
  if (accepted.length < 2) throw usage('CONCLAVE_TOO_FEW_MEMBERS', `um conclave exige pelo menos 2 membros válidos; encontrados ${accepted.length}${listing ? ` (${listing})` : ''}`, { skipped });
  if (accepted.length > LABEL_ALPHABET.length) throw usage('CONCLAVE_TOO_MANY_MEMBERS', `um conclave aceita no máximo ${LABEL_ALPHABET.length} membros`);

  const effectiveQuorum = quorum ?? conclaveCfg.quorum ?? 2;
  if (!Number.isInteger(effectiveQuorum) || effectiveQuorum < 2 || effectiveQuorum > accepted.length) throw usage('CONCLAVE_INVALID_QUORUM', `quorum deve ser um inteiro entre 2 e ${accepted.length} (recebido ${preview(effectiveQuorum)})`);
  const effectiveJudge = resolveJudge(judge ?? conclaveCfg.judge ?? 'claude', { catalog, config, policy });
  if (effectiveJudge.type === 'model' && seen.has(effectiveJudge.full) && !allowJudgeMember) throw usage('CONCLAVE_JUDGE_IS_MEMBER', 'o juiz também é membro; informe --allow-judge-member para permitir');
  const members = shuffle(accepted, rng).map((m, i) => ({ label: LABEL_ALPHABET[i], ...m }));
  return { mode, members, quorum: effectiveQuorum, rounds: effectiveRounds, judge: effectiveJudge, warnings, skipped };
}

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

const GENERIC_NAME_WORDS = new Set([
  'air', 'alpha', 'api', 'app', 'audio', 'auto', 'base', 'beta', 'big', 'chat', 'cli', 'cloud', 'code', 'coder',
  'codex', 'command', 'deep', 'default', 'dev', 'edge', 'embed', 'embedding', 'exp', 'experimental', 'fast', 'final',
  'flash', 'free', 'high', 'hyper', 'image', 'instant', 'instruct', 'large', 'latest', 'light', 'lite', 'local', 'low',
  'max', 'medium', 'micro', 'mini', 'model', 'models', 'nano', 'new', 'next', 'old', 'omni', 'online', 'open', 'plus',
  'preview', 'pro', 'realtime', 'reasoner', 'reasoning', 'release', 'research', 'sdk', 'search', 'server', 'small',
  'speech', 'stable', 'super', 'test', 'text', 'the', 'thinking', 'turbo', 'ultra', 'version', 'vision', 'web', 'with',
]);

const VENDOR_ALIASES = Object.freeze({
  claude: ['anthropic'], deepseek: ['deepseek'], gemini: ['google', 'deepmind'], gemma: ['google', 'deepmind'],
  glm: ['zhipu', 'zhipuai'], gpt: ['openai', 'chatgpt'], grok: ['xai'], kimi: ['moonshot', 'moonshotai'],
  llama: ['meta'], minimax: ['minimax'], mistral: ['mistralai'], codestral: ['mistral', 'mistralai'],
  mixtral: ['mistral', 'mistralai'], phi: ['microsoft'], qwen: ['alibaba', 'tongyi'],
  yi: ['01ai'], baichuan: ['baichuan'], ernie: ['baidu'], doubao: ['bytedance'],
  hunyuan: ['tencent'], command: ['cohere'], nemotron: ['nvidia'],
});
const CURATED_NAME_WORDS = new Set(Object.entries(VENDOR_ALIASES).flatMap(([family, vendors]) => [family, ...vendors]));

function familyWordsOf(text, participant = false) {
  const words = [];
  for (const token of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const lead = token.match(/^\p{L}+/u)?.[0];
    if (lead && (CURATED_NAME_WORDS.has(lead) || (participant && lead.length >= 3 && !GENERIC_NAME_WORDS.has(lead)))) words.push(lead);
  }
  return words;
}

export function buildKnownNames(catalog, { extraModels = [] } = {}) {
  const exact = new Set();
  const families = new Set();
  const addExact = (value) => {
    const v = String(value ?? '').trim();
    if (v) exact.add(v);
  };
  const addToken = (value, participant = false) => {
    const v = String(value ?? '').trim();
    const word = v.toLowerCase();
    if (/\p{N}/u.test(v) || CURATED_NAME_WORDS.has(word) || (participant && v.length >= 3 && !GENERIC_NAME_WORDS.has(word))) addExact(v);
  };
  const addProvider = (provider, participant = false) => {
    addExact(provider);
    for (const word of String(provider ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) addToken(word, participant);
    for (const word of familyWordsOf(provider, participant)) families.add(word);
  };
  const addModel = (m, participant = false) => {
    if (!m?.modelID) return;
    addProvider(m.providerID, participant);
    addExact(m.full ?? (m.providerID ? `${m.providerID}/${m.modelID}` : null));
    const segments = String(m.modelID).split('/');
    if (segments.length > 1) addExact(m.modelID);
    for (const segment of segments) addToken(segment, participant);
    // Display names are phrases, never a source of individual words or families.
    if (/\s/u.test(String(m.name ?? '').trim())) addExact(m.name);
    else addToken(m.name);
    for (const segment of segments) {
      for (const word of familyWordsOf(segment, participant && segment === segments.at(-1))) families.add(word);
    }
  };
  for (const provider of catalog?.connected ?? []) addProvider(provider);
  for (const model of catalog?.models ?? []) addModel(model);
  for (const model of extraModels) addModel(model, true);
  for (const family of families) for (const vendor of VENDOR_ALIASES[family] ?? []) exact.add(vendor);
  return { exact: [...exact], families: [...families] };
}

function mergeKnownNames(supplied, derived) {
  const asLists = (names) => Array.isArray(names) ? { exact: names, families: [] } : (names ?? {});
  const given = asLists(supplied);
  return {
    exact: [...new Set([...(given.exact ?? []), ...derived.exact])],
    families: [...new Set([...(given.families ?? []), ...derived.families])],
  };
}

const compiledNames = new WeakMap();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileNames(knownNames) {
  const cacheable = knownNames && typeof knownNames === 'object';
  if (cacheable && compiledNames.has(knownNames)) return compiledNames.get(knownNames);
  const spec = Array.isArray(knownNames) ? { exact: knownNames, families: [] } : (knownNames ?? {});
  const prepare = (list) => [...new Set((list ?? []).map((s) => String(s).trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length).map(escapeRegExp);
  const exact = prepare(spec.exact);
  const families = prepare(spec.families);
  const before = '(?<![\\p{L}\\p{N}_])';
  const after = '(?![\\p{L}\\p{N}_])';
  const alternatives = [];
  if (exact.length) alternatives.push(`${before}(?:${exact.join('|')})${after}`);
  if (families.length) alternatives.push(`${before}(?:${families.join('|')})(?:(?:[-_][\\p{L}]+)*[-_]?\\p{N}(?:[\\p{L}\\p{N}_-]|\\.(?=[\\p{L}\\p{N}]))*)?${after}`);
  // One pass over the original text; existing markers are consumed intact as well.
  const compiled = new RegExp([escapeRegExp(REDACTED_NAME), ...alternatives].join('|'), 'giu');
  if (cacheable) compiledNames.set(knownNames, compiled);
  return compiled;
}

export function anonymize(text, knownNames) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  return text.replace(compileNames(knownNames), REDACTED_NAME);
}

export function anonymizeValue(value, knownNames) {
  if (typeof value === 'string') return anonymize(value, knownNames);
  if (Array.isArray(value)) return value.map((v) => anonymizeValue(v, knownNames));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymizeValue(v, knownNames)]));
  return value;
}

// ---------------------------------------------------------------------------
// Review clustering and verdict
// ---------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'no', 'not', 'of', 'on',
  'or', 'the', 'this', 'that', 'to', 'when', 'with',
  'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'nos', 'o', 'os', 'para', 'por', 'que', 'sem', 'um', 'uma',
]);

function severityRank(severity) {
  return SEVERITY_ORDER.indexOf(String(severity ?? '').toLowerCase());
}

export function titleTokens(title) {
  return new Set(
    String(title ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !TITLE_STOPWORDS.has(t)),
  );
}

export function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const NO_FILE_VALUES = new Set(['', '-', 'n/a', 'na', 'none', '(none)', 'null', 'unknown', 'general', 'global', '*']);

function normalizeFile(file) {
  if (typeof file !== 'string') return null;
  const prepared = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (NO_FILE_VALUES.has(prepared.toLowerCase())) return null;
  return path.posix.normalize(prepared);
}

function toLine(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function lineRange(finding) {
  const start = toLine(finding.line_start);
  const end = toLine(finding.line_end);
  if (start === null && end === null) return null;
  const a = start ?? end;
  const b = end ?? start;
  return a <= b ? [a, b] : [b, a];
}

function rangesNear(r1, r2) {
  if (!r1 && !r2) return true;
  if (!r1 || !r2) return false;
  return Math.max(r1[0], r2[0]) - Math.min(r1[1], r2[1]) <= CLUSTER_LINE_GAP;
}

function confidenceOf(finding) {
  return typeof finding.confidence === 'number' && Number.isFinite(finding.confidence) ? finding.confidence : null;
}

export function clusterFindings(findingsByMember, { validCount = null } = {}) {
  const labels = Object.keys(findingsByMember ?? {}).sort();
  const n = validCount ?? labels.length;
  const items = [];
  for (const label of labels) {
    for (const finding of findingsByMember[label] ?? []) {
      if (!finding || typeof finding !== 'object') continue;
      items.push({ label, finding, file: normalizeFile(finding.file), range: lineRange(finding), confidence: confidenceOf(finding), order: items.length });
    }
  }
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.file === null || b.file === null || a.file !== b.file) continue;
      if (!rangesNear(a.range, b.range)) continue;
      if (titleSimilarity(a.finding.title, b.finding.title) < CLUSTER_TITLE_THRESHOLD) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  const clusters = [...groups.values()].map((group) => {
    const memberLabels = [...new Set(group.map((g) => g.label))].sort();
    const best = [...group].sort((x, y) => ((y.confidence ?? -1) - (x.confidence ?? -1)) || (x.order - y.order))[0];
    let severity = String(group[0].finding.severity ?? '').toLowerCase() || null;
    for (const g of group) {
      if (severityRank(g.finding.severity) > severityRank(severity)) severity = String(g.finding.severity).toLowerCase();
    }
    const ranges = group.map((g) => g.range).filter(Boolean);
    const confidences = group.map((g) => g.confidence).filter((c) => c !== null);
    const mean = confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : null;
    return {
      id: null,
      file: group[0].file,
      line_start: ranges.length ? Math.min(...ranges.map((r) => r[0])) : null,
      line_end: ranges.length ? Math.max(...ranges.map((r) => r[1])) : null,
      severity,
      title: String(best.finding.title ?? ''),
      body: String(best.finding.body ?? ''),
      recommendation: String(best.finding.recommendation ?? ''),
      agreement: { k: memberLabels.length, n, text: `${memberLabels.length}/${n}` },
      labels: memberLabels,
      meanConfidence: mean === null ? null : Math.round(mean * 100) / 100,
      bestLabel: best.label,
      findings: group.map((g) => ({
        label: g.label,
        title: String(g.finding.title ?? ''),
        severity: g.finding.severity ?? null,
        confidence: g.confidence,
        line_start: g.range ? g.range[0] : null,
        line_end: g.range ? g.range[1] : null,
      })),
    };
  });
  clusters.sort((x, y) => (severityRank(y.severity) - severityRank(x.severity))
    || (y.agreement.k - x.agreement.k)
    || ((y.meanConfidence ?? -1) - (x.meanConfidence ?? -1))
    || (x.file === null) - (y.file === null)
    || String(x.file ?? '').localeCompare(String(y.file ?? ''))
    || ((x.line_start ?? 0) - (y.line_start ?? 0))
    || x.title.localeCompare(y.title));
  clusters.forEach((c, i) => { c.id = `C${i + 1}`; });
  return clusters;
}

export function conclaveVerdict(clusters, memberVerdicts) {
  const verdicts = Object.values(memberVerdicts ?? {});
  const reasons = [];
  for (const c of clusters ?? []) {
    if (severityRank(c.severity) >= severityRank('high') && c.agreement.k >= 2) {
      reasons.push({ code: 'SEVERE_FINDING_AGREED', clusterId: c.id, severity: c.severity, agreement: c.agreement.text });
    }
  }
  const needs = verdicts.filter((v) => v === 'needs-attention').length;
  if (verdicts.length > 0 && needs > verdicts.length / 2) {
    reasons.push({ code: 'MAJORITY_NEEDS_ATTENTION', count: needs, of: verdicts.length });
  }
  return { verdict: reasons.length > 0 ? 'needs-attention' : 'approve', reasons };
}

// ---------------------------------------------------------------------------
// Rounds, judge and package
// ---------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  const width = Math.max(1, Math.min(limit || 1, items.length));
  const lanes = await Promise.allSettled(Array.from({ length: width }, async () => {
    while (!stopped && next < items.length) {
      const i = next;
      next += 1;
      try { results[i] = await fn(items[i], i); }
      catch (err) { stopped = true; throw err; }
    }
  }));
  // Drain in-flight turns before the worker finalizes their jobs and closes the API.
  const failure = lanes.find((lane) => lane.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

function truncateText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function byLabel(a, b) { return a.label.localeCompare(b.label); }

function outputContract(mode, schema) {
  return mode === 'tool' ? 'Return your answer only through the structured output.' : `Return only one JSON object inside a single \`\`\`json fence, with no text outside it. Return a JSON instance with field values, not the schema. Follow this JSON Schema:\n${JSON.stringify(schema, null, 2)}`;
}

export class ConclavePersistenceError extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause), { cause });
    this.name = 'ConclavePersistenceError';
    this.code = 'coordinator_error';
  }
}

async function safeTurn(deps, spec) {
  try { return await deps.turn(spec); }
  catch (err) {
    if (err instanceof ConclavePersistenceError) throw err;
    return { status: 'failed', sessionID: spec.sessionID ?? null, structured: null, finalText: '', errorType: err?.code ?? err?.name ?? 'Error', errorClass: 'fatal', errorMessage: err?.message ?? String(err) };
  }
}

const SCHEMA_ECHO_KEYS = new Set(['$schema', '$id', 'title', 'type', 'description']);

function checkTurn(turn, schema) {
  if (!turn || turn.status !== 'completed') {
    const errorType = turn?.status === 'cancelled' ? 'Cancelled' : (turn?.errorType ?? 'Failed');
    return { ok: false, errorType, message: turn?.errorMessage ?? `turn ended with status ${turn?.status ?? 'unknown'}` };
  }
  if (turn.structured === null || turn.structured === undefined) return { ok: false, errorType: 'MissingStructuredOutput', message: 'turn completed without structured output' };
  const errors = validateSchema(turn.structured, schema);
  if (errors.length && typeOf(turn.structured) === 'object') {
    // Models sometimes echo the schema shape: values under `properties`, or schema keywords beside the values.
    if (typeOf(turn.structured.properties) === 'object' && validateSchema(turn.structured.properties, schema).length === 0) {
      return { ok: true, structured: turn.structured.properties };
    }
    const stripped = Object.fromEntries(Object.entries(turn.structured).filter(([key]) => !SCHEMA_ECHO_KEYS.has(key) || Object.hasOwn(schema.properties ?? {}, key)));
    if (Object.keys(stripped).length < Object.keys(turn.structured).length && validateSchema(stripped, schema).length === 0) {
      return { ok: true, structured: stripped };
    }
  }
  if (errors.length) return { ok: false, errorType: 'InvalidStructuredOutput', message: errors.slice(0, 5).map(e => `${e.path} ${e.message}`).join('; ') };
  return { ok: true, structured: turn.structured };
}

function failureRecord({ label, round, role, turn, check }) {
  return { label, round, role, errorType: check.errorType, errorClass: turn?.errorClass ?? null, message: check.message, rawText: turn?.finalText ? truncateText(String(turn.finalText), RAW_TEXT_MAX_CHARS) : null };
}

const STRUCTURAL_FIELDS = new Set([
  'type', 'status', 'mode', 'label', 'labels', 'round', 'role', 'errorType', 'errorClass',
  'verdict', 'severity', 'line', 'line_start', 'line_end', 'agreement', 'id', 'ids', 'code',
  'schemaVersion', 'kind', 'confidence', 'validMembers', 'meanConfidence', 'rounds',
  'quorum', 'durationMs', 'startedAt', 'endedAt', 'sessionID', 'model', 'target',
]);
const FREE_TEXT_FIELDS = new Set(['title', 'body', 'recommendation', 'summary', 'next_steps', 'message', 'rawText']);

function anonymizeFreeText(value, knownNames) {
  if (typeof value === 'string') return anonymize(value, knownNames);
  if (Array.isArray(value)) return value.map((item) => anonymizeFreeText(item, knownNames));
  return value;
}

function anonymizeFilePath(value, knownNames) {
  if (typeof value !== 'string') return value;
  return value.split(/([\\/])/).map((part) => anonymize(part, knownNames)).join('');
}

function anonymizeModelContent(value, knownNames) {
  if (typeof value === 'string') return anonymize(value, knownNames);
  if (Array.isArray(value)) return value.map((item) => anonymizeModelContent(item, knownNames));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'file' ? anonymizeFilePath(item, knownNames) : STRUCTURAL_FIELDS.has(key) ? item : anonymizeModelContent(item, knownNames),
  ]));
}

function anonymizeConclavePackage(value, knownNames) {
  if (Array.isArray(value)) return value.map((item) => anonymizeConclavePackage(item, knownNames));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'file') return [key, anonymizeFilePath(item, knownNames)];
    if (STRUCTURAL_FIELDS.has(key) || key === 'question' || key === 'composition' || key === 'memberVerdicts' || key === 'reasons') return [key, item];
    if (key === 'response' || key === 'structured' || key === 'synthesis') return [key, anonymizeModelContent(item, knownNames)];
    if (FREE_TEXT_FIELDS.has(key)) return [key, anonymizeFreeText(item, knownNames)];
    if (key === 'warnings' && Array.isArray(item)) return [key, item.map((warning) => typeof warning === 'string' ? anonymize(warning, knownNames) : warning)];
    return [key, anonymizeConclavePackage(item, knownNames)];
  }));
}

function formatLabeled(entries, knownNames, tag) {
  return entries.map(e => `<${tag} label="${e.label}">\n${truncateText(JSON.stringify(anonymizeModelContent(e.response, knownNames), null, 2), PEER_RESPONSE_MAX_CHARS)}\n</${tag}>`).join('\n\n');
}

function memberSpecPrompt(run, state, round, previous) {
  const { flags, assets } = run; const label = state.member.label;
  if (round === 1) { const schema = buildMemberSchema(assets.schemas.member); return { schema, prompt: fillTemplate(assets.prompts.member, { SELF_LABEL: label, QUESTION: run.question, PROJECT_CONTEXT: run.projectContext, OUTPUT_CONTRACT: outputContract(run.structuredOutput, schema) }, { strict: true }) }; }
  const peers = previous.responses.filter(r => r.label !== label); const peerLabels = peers.map(p => p.label);
  const schema = buildDebateSchema(assets.schemas.member, peerLabels); return { schema, prompt: fillTemplate(assets.prompts.debate, { SELF_LABEL: label, ROUND: round, TOTAL_ROUNDS: flags.rounds, QUESTION: run.question, PEER_LABELS: peerLabels.join(', '), PEER_RESPONSES: formatLabeled(peers, run.knownNames, 'peer'), OUTPUT_CONTRACT: outputContract(run.structuredOutput, schema) }, { strict: true }) };
}

async function collectRound(run, round, outcomes) {
  const entry = { round, responses: [], failures: [] };
  for (const { label, sessionID, turn, check } of outcomes) {
    if (check.ok) { entry.responses.push({ label, response: check.structured }); await run.emit({ type: 'member-done', role: 'member', label, round, sessionID: sessionID ?? null }); }
    else { const failure = failureRecord({ label, round, role: 'member', turn, check }); entry.failures.push(failure); run.failures.push(failure); await run.emit({ type: 'member-failed', ...failure }); }
  }
  entry.responses.sort(byLabel); entry.failures.sort(byLabel); return entry;
}
function quorumFailure(entry, quorum) { return { code: 'QUORUM_NOT_MET', round: entry.round, valid: entry.responses.length, quorum }; }

async function runDiscussion(run) {
  const { flags, deps, emit } = run;
  const states = flags.members.map((member) => ({ member, sessionID: null, active: true }));
  const roundsData = [];
  let completedRounds = 0;
  for (let round = 1; round <= flags.rounds; round += 1) {
    const active = states.filter((state) => state.active);
    const previous = roundsData.at(-1);
    await emit({ type: 'round-start', round, labels: active.map((state) => state.member.label) });
    const outcomes = await mapLimit(active, run.maxParallel, async (state) => {
      const label = state.member.label;
      const { schema, prompt } = memberSpecPrompt(run, state, round, previous);
      await emit({ type: 'member-start', role: 'member', label, round });
      const turn = await safeTurn(deps, {
        role: 'member', label, round, member: state.member, sessionID: state.sessionID, prompt, schema,
        title: `OPC: conclave: ${label}: ${run.question.slice(0, 48)}`,
      });
      if (turn?.sessionID) state.sessionID = turn.sessionID;
      const check = checkTurn(turn, schema);
      if (check.ok && round < flags.rounds && !state.sessionID) {
        check.ok = false;
        check.errorType = 'MissingSession';
        check.message = 'completed turn did not provide a session ID for a later round';
      }
      return { label, sessionID: state.sessionID, turn, check };
    });
    const entry = await collectRound(run, round, outcomes);
    for (const failure of entry.failures) {
      const failedState = states.find((state) => state.member.label === failure.label);
      if (failedState) failedState.active = false;
    }
    roundsData.push(entry);
    if (entry.responses.length < flags.quorum) {
      return { ok: false, roundsData, completedRounds, review: null, failure: quorumFailure(entry, flags.quorum) };
    }
    completedRounds = round;
  }
  return { ok: true, roundsData, completedRounds, review: null, failure: null };
}

function reviewForJudge(review) {
  return { verdict: review.verdict, validMembers: review.validMembers, clusters: review.clusters.map(c => ({ id: c.id, file: c.file, line_start: c.line_start, line_end: c.line_end, severity: c.severity, title: c.title, body: c.body, recommendation: c.recommendation, agreement: c.agreement.text, labels: c.labels, meanConfidence: c.meanConfidence })) };
}

async function runJudge(run, finalResponses, review) {
  const { flags, assets, deps, emit, knownNames } = run;
  if (flags.judge.type === 'claude') return { type: 'claude', status: 'pending' };
  const labels = finalResponses.map(r => r.label); const schema = buildSynthesisSchema(assets.schemas.synthesis, labels);
  const question = run.question || (review ? `Code review of ${review.target ?? 'the current changes'}` : '');
  const prompt = fillTemplate(assets.prompts.judge, { QUESTION: question, MODE: flags.mode, LABELS: labels.join(', '), DEBATE_NOTE: flags.rounds > 1 ? ` and then debated for ${flags.rounds - 1} more round(s)` : '', RESPONSES: formatLabeled(finalResponses, knownNames, 'answer'), REVIEW_SUMMARY: review ? JSON.stringify(anonymizeConclavePackage(reviewForJudge(review), knownNames), null, 2) : 'Not a review conclave.', OUTPUT_CONTRACT: outputContract(run.structuredOutput, schema) }, { strict: true });
  await emit({ type: 'judge-start', model: flags.judge.full });
  const turn = await safeTurn(deps, { role: 'judge', label: 'judge', round: null, member: flags.judge, sessionID: null, prompt, schema, title: 'OPC: conclave: judge' }); const check = checkTurn(turn, schema);
  if (!check.ok) { run.warnings.push(`A síntese do juiz ${flags.judge.full} falhou (${check.errorType}); use a skill opc-conclave com synthesisInput`); await emit({ type: 'judge-failed', errorType: check.errorType, message: check.message }); return { type: 'model', model: flags.judge.full, status: 'failed', sessionID: turn?.sessionID ?? null, error: { errorType: check.errorType, message: check.message, rawText: turn?.finalText ? truncateText(String(turn.finalText), RAW_TEXT_MAX_CHARS) : null } }; }
  await emit({ type: 'judge-done', sessionID: turn.sessionID ?? null }); return { type: 'model', model: flags.judge.full, status: 'completed', sessionID: turn.sessionID ?? null, synthesis: check.structured };
}

function synthesisInputOf(run, phase, finalResponses) {
  return { question: run.question, mode: run.flags.mode, labels: finalResponses.map(r => r.label), rounds: phase.completedRounds, responses: finalResponses.map(r => ({ label: r.label, response: anonymizeModelContent(r.response, run.knownNames) })), review: phase.review ? anonymizeConclavePackage(reviewForJudge(phase.review), run.knownNames) : null };
}

export async function runConclave({ ctx = {}, question = '', flags, deps }) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const derivedKnownNames = buildKnownNames(
    { connected: [], models: [] },
    { extraModels: [...flags.members, ...(flags.judge.type === 'model' ? [flags.judge] : [])] },
  );
  const run = {
    question: String(question ?? ''),
    flags,
    deps,
    assets: deps.assets ?? loadConclaveAssets(),
    knownNames: mergeKnownNames(deps.knownNames, derivedKnownNames),
    emit: (() => {
      let eventQueue = Promise.resolve();
      return (event) => {
        eventQueue = eventQueue.then(() => deps.onEvent?.(event));
        return eventQueue;
      };
    })(),
    maxParallel: flags.maxParallel ?? ctx.config?.jobs?.maxParallel ?? 4,
    projectContext: projectContextBlock(ctx.config?.project),
    structuredOutput: ctx.config?.conclave?.structuredOutput ?? 'text',
    failures: [],
    warnings: [...(flags.warnings ?? [])],
  };
  const phase = flags.mode === 'review' ? await runReview(run) : await runDiscussion(run);
  const lastRound = phase.roundsData.at(-1);
  const finalResponses = lastRound?.responses ?? [];
  const status = phase.ok ? 'completed' : 'failed';
  const judge = phase.ok
    ? await runJudge(run, finalResponses, phase.review)
    : { type: flags.judge.type, ...(flags.judge.type === 'model' ? { model: flags.judge.full } : {}), status: 'skipped' };
  const endedAt = now();
  const pkg = {
    schemaVersion: 1,
    kind: 'conclave',
    status,
    failure: phase.failure,
    mode: flags.mode,
    question: run.question,
    rounds: { requested: flags.rounds, completed: phase.completedRounds },
    quorum: flags.quorum,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    warnings: run.warnings,
    failures: run.failures,
    roundsData: phase.roundsData,
    final: { round: lastRound?.round ?? 0, responses: finalResponses },
    review: phase.review,
    judge,
    synthesisInput: phase.ok ? synthesisInputOf(run, phase, finalResponses) : null,
    composition: flags.members.map((member) => ({ label: member.label, model: member.full })),
  };
  // Protect every member/judge supplied string in the package while preserving the
  // original question (A5) and the deliberately identifying composition (A20).
  const protectedPkg = anonymizeConclavePackage(pkg, run.knownNames);
  Object.assign(pkg, protectedPkg, { question: run.question, composition: pkg.composition });
  if (pkg.synthesisInput) pkg.synthesisInput.question = run.question;
  if (pkg.judge?.type === 'model') pkg.judge.model = flags.judge.full;
  return pkg;
}

// ---------------------------------------------------------------------------
// Review mode
// ---------------------------------------------------------------------------

function reviewTemplateVars(context, question, projectContext = '') {
  return {
    PROJECT_CONTEXT: projectContext,
    TARGET_LABEL: context.label ?? 'the current changes',
    REVIEW_INPUT: context.content ?? '',
    REVIEW_SUMMARY: context.summary ?? '',
    USER_FOCUS: question.trim() || 'No extra focus was given; review for correctness, security and maintainability.',
    REVIEW_COLLECTION_GUIDANCE: context.truncated
      ? 'The diff above was truncated to fit. Read the changed files listed in the summary with the read tool before concluding.'
      : 'The complete diff is included above.',
  };
}

// Members receive the strict review schema; validation accepts findings without a location,
// which then become singleton clusters (spec §11.2).
function lenientReviewSchema(reviewSchemaFile) {
  const schema = stripMeta(reviewSchemaFile);
  const item = schema?.properties?.findings?.items;
  if (!item?.properties) return schema;
  const locationKeys = ['file', 'line_start', 'line_end'];
  for (const key of locationKeys) {
    const prop = item.properties[key];
    if (!prop) continue;
    const types = Array.isArray(prop.type) ? prop.type : (prop.type ? [prop.type] : []);
    const relaxed = { ...prop };
    if (types.length) relaxed.type = [...new Set([...types, 'null'])];
    delete relaxed.minLength;
    delete relaxed.minimum;
    item.properties[key] = relaxed;
  }
  if (Array.isArray(item.required)) item.required = item.required.filter((k) => !locationKeys.includes(k));
  return schema;
}

async function runReview(run) {
  const { flags, deps, emit, assets } = run;
  let context;
  try {
    if (typeof deps.collectReview !== 'function') throw new Error('review mode needs deps.collectReview');
    context = await deps.collectReview();
  } catch (err) {
    return { ok: false, roundsData: [], completedRounds: 0, review: null, failure: { code: 'REVIEW_CONTEXT_FAILED', message: err?.message ?? String(err) } };
  }
  const schema = stripMeta(assets.schemas.review);
  const validation = lenientReviewSchema(assets.schemas.review);
  let prompt = fillTemplate(assets.prompts.review, reviewTemplateVars(context, run.question, run.projectContext), { strict: true });
  // F2b's review.md has no {{USER_FOCUS}} (only adversarial-review.md does): the question (review
  // focus, A19) is appended instead of silently dropped.
  const focus = run.question.trim();
  if (focus && !assets.prompts.review.includes('{{USER_FOCUS}}')) prompt = `${prompt}\n\n<user_focus>\n${focus}\n</user_focus>`;
  prompt = `${prompt}\n\n${outputContract(run.structuredOutput, schema)}`;
  await emit({ type: 'round-start', round: 1, labels: flags.members.map((m) => m.label) });
  const outcomes = await mapLimit(flags.members, run.maxParallel, async (member) => {
    await emit({ type: 'member-start', role: 'member', label: member.label, round: 1 });
    const turn = await safeTurn(deps, {
      role: 'member', label: member.label, round: 1, member, sessionID: null, prompt, schema,
      title: `OPC: conclave: review ${member.label}`,
    });
    return { label: member.label, sessionID: turn?.sessionID ?? null, turn, check: checkTurn(turn, validation) };
  });
  const entry = await collectRound(run, 1, outcomes);
  if (entry.responses.length < flags.quorum) {
    return { ok: false, roundsData: [entry], completedRounds: 0, review: null, failure: quorumFailure(entry, flags.quorum) };
  }
  const findingsByMember = Object.fromEntries(entry.responses.map((r) => [r.label, Array.isArray(r.response.findings) ? r.response.findings : []]));
  const memberVerdicts = Object.fromEntries(entry.responses.map((r) => [r.label, r.response.verdict]));
  const clusters = clusterFindings(findingsByMember, { validCount: entry.responses.length });
  const { verdict, reasons } = conclaveVerdict(clusters, memberVerdicts);
  return {
    ok: true,
    roundsData: [entry],
    completedRounds: 1,
    failure: null,
    review: { target: context.label ?? null, truncated: Boolean(context.truncated), validMembers: entry.responses.length, memberVerdicts, verdict, reasons, clusters },
  };
}
