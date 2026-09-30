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
      const reason = err.message.replaceAll(entry, preview(entry));
      skipped.push({ entry: preview(entry), reason, denied: false });
      warnings.push(`conclave: ignorando "${preview(entry)}": ${reason}`);
      continue;
    }
    if (!catalog.connected.has(resolved.providerID)) {
      const reason = 'o provider não está conectado';
      skipped.push({ entry: preview(entry), reason, denied: false });
      warnings.push(`conclave: ignorando "${preview(entry)}": ${reason}`);
      continue;
    }
    const denial = policyDenial(resolved, policy);
    if (denial) {
      skipped.push({ entry: preview(entry), reason: denial, denied: true });
      warnings.push(`conclave: ignorando "${preview(entry)}": ${denial}`);
      continue;
    }
    if (seen.has(resolved.full)) {
      warnings.push(`conclave: membro duplicado "${preview(entry)}" ignorado`);
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
  phi: ['microsoft'], qwen: ['alibaba', 'tongyi'],
});

function familyWordsOf(text) {
  const words = [];
  for (const token of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const lead = token.match(/^\p{L}+/u)?.[0];
    if (lead && lead.length >= 3 && !GENERIC_NAME_WORDS.has(lead)) words.push(lead);
  }
  return words;
}

export function buildKnownNames(catalog, { extraModels = [] } = {}) {
  const exact = new Set();
  const families = new Set();
  const addExact = (value, { modelId = false } = {}) => {
    const v = String(value ?? '').trim();
    if (v.length >= 3 || (modelId && /\p{N}/u.test(v))) exact.add(v);
  };
  const providers = new Set(catalog?.connected ?? []);
  for (const m of [...(catalog?.models ?? []), ...extraModels]) {
    if (!m?.modelID) continue;
    if (m.providerID) providers.add(m.providerID);
    addExact(m.full);
    addExact(m.modelID, { modelId: true });
    const segments = String(m.modelID).split('/');
    addExact(segments.at(-1), { modelId: true });
    for (const namespace of segments.slice(0, -1)) addExact(namespace);
    addExact(m.name);
    for (const w of familyWordsOf(segments.at(-1))) families.add(w);
    for (const w of familyWordsOf(m.name)) families.add(w);
  }
  for (const p of providers) {
    addExact(p);
    for (const token of String(p).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length >= 3 && !GENERIC_NAME_WORDS.has(token)) exact.add(token);
    }
  }
  for (const family of families) for (const vendor of VENDOR_ALIASES[family] ?? []) exact.add(vendor);
  return { exact: [...exact], families: [...families] };
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
  const compiled = {
    exact: exact.length ? new RegExp(`${before}(?:${exact.join('|')})${after}`, 'giu') : null,
    family: families.length ? new RegExp(`${before}(?:${families.join('|')})(?:[\\p{L}\\p{N}_-]|\\.(?=[\\p{L}\\p{N}]))*`, 'giu') : null,
  };
  if (cacheable) compiledNames.set(knownNames, compiled);
  return compiled;
}

export function anonymize(text, knownNames) {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  const { exact, family } = compileNames(knownNames);
  let out = text;
  if (exact) out = out.replace(exact, REDACTED_NAME);
  if (family) out = out.replace(family, REDACTED_NAME);
  return out;
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
