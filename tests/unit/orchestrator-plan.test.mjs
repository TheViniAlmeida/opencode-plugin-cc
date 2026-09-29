import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  validatePlan, findCycle, planSchema, normalizeSubtask,
  SUBTASK_KINDS, TIERS, MIN_SUBTASKS, MAX_SUBTASKS_CAP, SUBTASK_ID_PATTERN,
} from '../../plugins/opc/scripts/lib/orchestrator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, 'plugins/opc/schemas/orchestrate-plan.schema.json'), 'utf8'));

const sub = (id, extra = {}) => ({ id, title: `Title ${id}`, prompt: `Do ${id}`, kind: 'ask', dependsOn: [], ...extra });
const plan = (subtasks, extra = {}) => ({ rationale: 'Split by concern.', subtasks, ...extra });

test('schema file matches the validator constants', () => {
  const item = SCHEMA.properties.subtasks.items;
  assert.deepEqual(item.properties.kind.enum, [...SUBTASK_KINDS]);
  assert.deepEqual(item.properties.tier.enum, [...TIERS]);
  assert.equal(SCHEMA.properties.subtasks.minItems, MIN_SUBTASKS);
  assert.equal(SCHEMA.properties.subtasks.maxItems, MAX_SUBTASKS_CAP);
  assert.equal(item.properties.id.pattern, SUBTASK_ID_PATTERN.source);
  assert.deepEqual(item.required, ['id', 'title', 'prompt', 'kind', 'dependsOn']);
  assert.deepEqual(SCHEMA.required, ['subtasks', 'rationale']);
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(item.additionalProperties, false);
});

test('planSchema sets maxItems without mutating the original', () => {
  const copy = planSchema(SCHEMA, 4);
  assert.equal(copy.properties.subtasks.maxItems, 4);
  assert.equal(SCHEMA.properties.subtasks.maxItems, MAX_SUBTASKS_CAP);
});

test('a valid plan passes', () => {
  const r = validatePlan(plan([sub('a'), sub('b'), sub('c', { dependsOn: ['a', 'b'], kind: 'review', tier: 'heavy', files: ['src/x.mjs'] })]));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('non-object plans and missing arrays are rejected without throwing', () => {
  for (const bad of [null, 'text', 42, [], { rationale: 'x' }]) {
    const r = validatePlan(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});

test('subtask count must be within 2..maxSubtasks', () => {
  assert.match(validatePlan(plan([sub('a')])).errors.join('\n'), /entre 2 e 5 itens \(recebido 1\)/);
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => sub(id));
  assert.match(validatePlan(plan(six)).errors.join('\n'), /entre 2 e 5 itens \(recebido 6\)/);
  assert.equal(validatePlan(plan(six), { maxSubtasks: 6 }).ok, true);
});

test('ids must be unique and well formed', () => {
  const errs = validatePlan(plan([sub('a'), sub('a'), sub('bad id')])).errors.join('\n');
  assert.match(errs, /id de subtarefa duplicado "a"/);
  assert.match(errs, /subtasks\[2\]\.id deve corresponder/);
});

test('unknown properties, bad kinds and bad tiers are reported', () => {
  const errs = validatePlan(plan([sub('a', { kind: 'deploy', extra: 1 }), sub('b', { tier: 'medium' })], { notes: 'x' })).errors.join('\n');
  assert.match(errs, /plano tem propriedade desconhecida "notes"/);
  assert.match(errs, /subtarefa "a" tem propriedade desconhecida "extra"/);
  assert.match(errs, /subtarefa "a": kind deve ser um de ask, plan, review, task/);
  assert.match(errs, /subtarefa "b": tier deve ser um de light, heavy/);
});

test('dependsOn must reference existing subtasks', () => {
  const errs = validatePlan(plan([sub('a', { dependsOn: ['ghost'] }), sub('b')])).errors.join('\n');
  assert.match(errs, /subtarefa "a" depende da subtarefa desconhecida "ghost"/);
});

test('missing dependsOn is rejected (required by the schema)', () => {
  const { dependsOn, ...noDeps } = sub('a');
  assert.match(validatePlan(plan([noDeps, sub('b')])).errors.join('\n'), /subtarefa "a": dependsOn deve ser um array/);
});

test('cycles are rejected with the cycle path', () => {
  const r = validatePlan(plan([sub('a', { dependsOn: ['b'] }), sub('b', { dependsOn: ['c'] }), sub('c', { dependsOn: ['a'] })]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ciclo de dependência: a -> b -> c -> a/);
});

test('self dependency is a cycle', () => {
  const r = validatePlan(plan([sub('a', { dependsOn: ['a'] }), sub('b')]));
  assert.match(r.errors.join('\n'), /ciclo de dependência: a -> a/);
});

test('findCycle returns null for a DAG with shared dependencies', () => {
  assert.equal(findCycle([sub('a'), sub('b', { dependsOn: ['a'] }), sub('c', { dependsOn: ['a', 'b'] })]), null);
});

test('write kinds require --write', () => {
  const p = plan([sub('w', { kind: 'task' }), sub('r')]);
  const denied = validatePlan(p, { write: false });
  assert.equal(denied.ok, false);
  assert.match(denied.errors.join('\n'), /subtarefa "w" tem kind "task" \(escreve arquivos\), mas a orquestração foi iniciada sem --write/);
  assert.equal(validatePlan(p, { write: true }).ok, true);
});

test('agents go through policy and must exist', () => {
  const policy = { agents: { allow: [], deny: ['work-*'] } };
  const agentsIndex = new Map([['build', { mode: 'primary' }], ['work-ops', { mode: 'primary' }]]);
  const errs = validatePlan(plan([sub('a', { agent: 'work-ops' }), sub('b', { agent: 'nope' }), sub('c', { agent: 'build' })]), { policy, agentsIndex }).errors;
  assert.equal(errs.length, 2);
  assert.match(errs.join('\n'), /subtarefa "a" usa o agente "work-ops", negado pela política/);
  assert.match(errs.join('\n'), /subtarefa "b" usa o agente desconhecido "nope"/);
});

test('normalizeSubtask fills optional fields and dedupes dependsOn', () => {
  assert.deepEqual(normalizeSubtask(sub('a', { dependsOn: ['b', 'b'] })), {
    id: 'a', title: 'Title a', prompt: 'Do a', kind: 'ask', tier: null, agent: null, files: [], dependsOn: ['b'],
  });
});
