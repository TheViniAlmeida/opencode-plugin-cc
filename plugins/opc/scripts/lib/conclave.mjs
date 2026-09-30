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
