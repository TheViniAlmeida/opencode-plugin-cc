// Orchestration: decompose a task with a planner model, run subtasks across models, synthesize.
// Composes runner + jobs through injected deps; never talks HTTP directly (spec §3.1).
import { evaluate } from './policy.mjs';
import { TIERS } from './routing.mjs';

// ---------------------------------------------------------------------------
// Constants and plan validation
// ---------------------------------------------------------------------------

export { TIERS }; // owned by routing.mjs (F4a)
export const SUBTASK_KINDS = Object.freeze(['ask', 'plan', 'review', 'task']);
export const WRITE_KINDS = Object.freeze(['task']);
export const MIN_SUBTASKS = 2;
export const MAX_SUBTASKS_CAP = 10;
export const SUBTASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

const SUBTASK_KEYS = new Set(['id', 'title', 'prompt', 'kind', 'tier', 'agent', 'files', 'dependsOn']);
const PLAN_KEYS = new Set(['subtasks', 'rationale']);

export function isWriteKind(kind) {
  return WRITE_KINDS.includes(kind);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Returns the first dependency cycle as a path of ids ending where it started, or null.
export function findCycle(subtasks) {
  const edges = new Map();
  for (const s of subtasks) {
    if (isPlainObject(s) && typeof s.id === 'string') {
      edges.set(s.id, Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : []);
    }
  }
  const color = new Map(); // 1 = on stack, 2 = done
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of edges.get(id)) {
      if (!edges.has(dep)) continue;
      if (color.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!color.has(dep)) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of edges.keys()) {
    if (!color.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function validatePlan(plan, { write = false, policy = {}, maxSubtasks = 5, agentsIndex = null } = {}) {
  const errors = [];
  if (!isPlainObject(plan)) return { ok: false, errors: ['plano deve ser um objeto JSON'] };
  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) errors.push(`plano tem propriedade desconhecida "${key}"`);
  }
  if (!isNonEmptyString(plan.rationale)) errors.push('rationale deve ser uma string não vazia');
  if (!Array.isArray(plan.subtasks)) {
    errors.push('subtasks deve ser um array');
    return { ok: false, errors };
  }
  const subtasks = plan.subtasks;
  if (subtasks.length < MIN_SUBTASKS || subtasks.length > maxSubtasks) {
    errors.push(`subtasks deve ter entre ${MIN_SUBTASKS} e ${maxSubtasks} itens (recebido ${subtasks.length})`);
  }

  const ids = new Set();
  subtasks.forEach((s, i) => {
    const where = `subtasks[${i}]`;
    if (!isPlainObject(s)) {
      errors.push(`${where} deve ser um objeto`);
      return;
    }
    const label = typeof s.id === 'string' && s.id !== '' ? `subtarefa "${s.id}"` : where;
    for (const key of Object.keys(s)) {
      if (!SUBTASK_KEYS.has(key)) errors.push(`${label} tem propriedade desconhecida "${key}"`);
    }
    if (typeof s.id !== 'string' || !SUBTASK_ID_PATTERN.test(s.id)) {
      errors.push(`${where}.id deve corresponder a ${SUBTASK_ID_PATTERN}`);
    } else if (ids.has(s.id)) {
      errors.push(`id de subtarefa duplicado "${s.id}"`);
    } else {
      ids.add(s.id);
    }
    if (!isNonEmptyString(s.title)) errors.push(`${label}: title deve ser uma string não vazia`);
    if (!isNonEmptyString(s.prompt)) errors.push(`${label}: prompt deve ser uma string não vazia`);
    if (!SUBTASK_KINDS.includes(s.kind)) {
      errors.push(`${label}: kind deve ser um de ${SUBTASK_KINDS.join(', ')}`);
    } else if (isWriteKind(s.kind) && !write) {
      errors.push(`${label} tem kind "${s.kind}" (escreve arquivos), mas a orquestração foi iniciada sem --write`);
    }
    if (s.tier !== undefined && !TIERS.includes(s.tier)) errors.push(`${label}: tier deve ser um de ${TIERS.join(', ')}`);
    if (s.files !== undefined && (!Array.isArray(s.files) || !s.files.every(isNonEmptyString))) {
      errors.push(`${label}: files deve ser um array de strings não vazias`);
    }
    if (!Array.isArray(s.dependsOn) || !s.dependsOn.every((d) => typeof d === 'string')) {
      errors.push(`${label}: dependsOn deve ser um array de ids de subtarefas`);
    }
    if (s.agent !== undefined) {
      if (!isNonEmptyString(s.agent)) {
        errors.push(`${label}: agent deve ser uma string não vazia`);
      } else {
        const verdict = evaluate('agent', s.agent, policy);
        if (!verdict.allowed) errors.push(`${label} usa o agente "${s.agent}", negado pela política (${verdict.rule ?? 'política'})`);
        else if (agentsIndex && !agentsIndex.has(s.agent)) errors.push(`${label} usa o agente desconhecido "${s.agent}"`);
      }
    }
  });

  let referencesOk = true;
  for (const s of subtasks) {
    if (!isPlainObject(s) || !Array.isArray(s.dependsOn)) continue;
    for (const dep of s.dependsOn) {
      if (typeof dep !== 'string') continue;
      if (dep !== s.id && !ids.has(dep)) {
        errors.push(`subtarefa "${s.id}" depende da subtarefa desconhecida "${dep}"`);
        referencesOk = false;
      }
    }
  }
  if (referencesOk) {
    const cycle = findCycle(subtasks);
    if (cycle) errors.push(`ciclo de dependência: ${cycle.join(' -> ')}`);
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeSubtask(s) {
  return {
    id: s.id,
    title: s.title,
    prompt: s.prompt,
    kind: s.kind,
    tier: s.tier ?? null,
    agent: s.agent ?? null,
    files: s.files ?? [],
    dependsOn: [...new Set(s.dependsOn ?? [])],
  };
}

// Copy of the schema file with maxItems set to the effective limit of this run.
export function planSchema(schema, maxSubtasks) {
  const copy = structuredClone(schema);
  copy.properties.subtasks.maxItems = maxSubtasks;
  return copy;
}
