import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMembers, validateConclaveOptions } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { makeCatalog, DS, QW, KM, EQ, PROVIDER } from './_conclave-fixtures.mjs';

const catalog = makeCatalog();
const baseConfig = {
  defaultProvider: PROVIDER, aliases: { fast: DS, strong: QW, k3: KM },
  policy: { providers: { allow: [], deny: ['omniroute-work'] }, models: { allow: [], deny: [] } },
  conclave: { pools: { default: ['fast', 'strong', 'k3'], duo: ['fast', 'strong'] }, defaultPool: 'default', judge: 'claude', rounds: 1, quorum: 2 },
};
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const compose = (opts) => composeMembers({ config: baseConfig, catalog, rng: seq(0), ...opts });
const usageCode = (code) => (err) => err.exitCode === 2 && err.code === code;

test('pool padrão resolve aliases e rótulos', () => {
  const out = compose({});
  assert.deepEqual(out.members.map((m) => m.label), ['A', 'B', 'C']);
  assert.deepEqual(new Set(out.members.map((m) => m.full)), new Set([DS, QW, KM]));
  assert.equal(out.quorum, 2); assert.equal(out.rounds, 1); assert.deepEqual(out.judge, { type: 'claude' });
  assert.ok(out.members.every((m) => m.source === 'pool:default'));
});
test('embaralha antes de atribuir rótulos', () => {
  const a = compose({ models: [DS, QW, KM], rng: seq(0.99, 0.99) });
  const b = compose({ models: [DS, QW, KM], rng: seq(0, 0) });
  assert.notDeepEqual(a.members.map((m) => m.full), b.members.map((m) => m.full));
  assert.deepEqual(a.members.map((m) => m.label), ['A', 'B', 'C']);
});
test('valida exclusividade e pool inexistente', () => {
  assert.throws(() => compose({ models: [DS, QW], pool: 'duo' }), usageCode('CONCLAVE_MODELS_AND_POOL'));
  assert.throws(() => compose({ pool: 'nope' }), usageCode('CONCLAVE_UNKNOWN_POOL'));
});
test('validação pré-servidor rejeita pool inexistente e seleções mutuamente exclusivas', () => {
  assert.throws(() => validateConclaveOptions({ pool: 'ausente', config: baseConfig }), usageCode('CONCLAVE_UNKNOWN_POOL'));
  assert.throws(() => validateConclaveOptions({ models: [], pool: 'duo', config: baseConfig }), usageCode('CONCLAVE_MODELS_AND_POOL'));
  assert.throws(() => validateConclaveOptions({ models: [DS, QW], pool: '', config: baseConfig }), usageCode('CONCLAVE_MODELS_AND_POOL'));
});
test('rejeita seleções explicitamente vazias', () => {
  assert.throws(() => validateConclaveOptions({ models: [] }), usageCode('CONCLAVE_EMPTY_SELECTION'));
  assert.throws(() => validateConclaveOptions({ pool: '' }), usageCode('CONCLAVE_EMPTY_SELECTION'));
});
test('exige pelo menos dois membros distintos', () => {
  assert.throws(() => compose({ models: [DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
  assert.throws(() => compose({ models: [DS, DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
});
test('valida quorum', () => {
  for (const quorum of [1, 4, 2.5]) assert.throws(() => compose({ quorum }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.equal(compose({ quorum: 3 }).quorum, 3);
});
test('valida modo e rodadas', () => {
  assert.equal(compose({ mode: 'debate' }).rounds, 2); assert.equal(compose({ mode: 'debate', rounds: 3 }).rounds, 3);
  assert.throws(() => compose({ mode: 'debate', rounds: 1 }), usageCode('CONCLAVE_DEBATE_ROUNDS'));
  for (const rounds of [4, 0]) assert.throws(() => compose({ rounds }), usageCode('CONCLAVE_INVALID_ROUNDS'));
  assert.equal(compose({ rounds: 2 }).rounds, 2); assert.equal(compose({ mode: 'review' }).rounds, 1);
  assert.throws(() => compose({ mode: 'review', rounds: 2 }), usageCode('CONCLAVE_REVIEW_ROUNDS'));
  assert.throws(() => compose({ mode: 'vote' }), usageCode('CONCLAVE_INVALID_MODE'));
});
test('debate usa configuração com duas ou mais rodadas', () => {
  const config = { ...baseConfig, conclave: { ...baseConfig.conclave, rounds: 3 } };
  assert.equal(composeMembers({ config, catalog, mode: 'debate', rng: seq(0) }).rounds, 3);
});
test('pula modelos negados, inválidos e duplicados com avisos', () => {
  const invalid = 'unknown-provider/very-long-model-name';
  const out = compose({ models: [DS, 'strong', QW, EQ, invalid, KM] });
  assert.deepEqual(out.members.map((m) => m.full).sort(), [DS, KM, QW].sort());
  assert.equal(out.warnings.length, 3);
  assert.ok(out.warnings.some((w) => w.includes(EQ.slice(0, 12)) && /negado pela política/.test(w)));
  assert.ok(out.warnings.some((w) => w.includes(`"${EQ}"`) && /negado pela política/.test(w)));
  assert.ok(out.warnings.some((w) => w.includes(invalid.slice(0, 12))));
  assert.ok(!out.warnings.some((w) => w.includes(invalid)));
  assert.ok(out.warnings.some((w) => /duplicado/.test(w)));
});
test('entrada de modelo vazia é registrada como ignorada com aviso', () => {
  const out = compose({ models: ['', DS, QW] });
  assert.ok(out.skipped.some((item) => item.entry === '' && /vazia|em branco/i.test(item.reason)));
  assert.ok(out.warnings.some((warning) => /vazia|em branco/i.test(warning)));
});
test('erros de rounds e quorum limitam o eco do valor a 12 caracteres', () => {
  const long = '12345678901234567890';
  for (const invoke of [
    () => validateConclaveOptions({ rounds: long }),
    () => validateConclaveOptions({ quorum: long }),
  ]) {
    let error;
    try { invoke(); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`${long.slice(0, 12)}…`));
    assert.ok(!error.message.includes(long));
  }
});
test('erro de poucos membros lista motivos sem ecoar entradas extensas', () => {
  const config = { ...baseConfig, policy: { models: { allow: [], deny: ['*kimi*', '*qwen*'] } } };
  assert.throws(() => composeMembers({ config, catalog, models: [DS, QW, KM], rng: seq(0) }),
    (err) => err.exitCode === 2 && /kimi/.test(err.message) && /qwen/.test(err.message));
});
test('todos negados pela política resultam em erro de política', () => {
  const config = { ...baseConfig, policy: { models: { allow: [], deny: ['*'] } } };
  assert.throws(() => composeMembers({ config, catalog, models: [DS, QW], rng: seq(0) }), (err) => err.exitCode === 4 && err.code === 'POLICY_DENIED');
});
test('resolve e valida juiz', () => {
  const out = compose({ models: [DS, QW], judge: 'k3' });
  assert.deepEqual(out.judge, { type: 'model', providerID: PROVIDER, modelID: 'opencode-go/kimi-k3', full: KM });
  assert.throws(() => compose({ models: [DS, QW], judge: EQ }), (err) => err.exitCode === 4);
  assert.throws(() => compose({ models: [DS, QW], judge: 'nope' }), usageCode('CONCLAVE_INVALID_JUDGE'));
});
test('juiz membro exige permissão explícita', () => {
  assert.throws(() => compose({ models: [DS, QW], judge: DS }), usageCode('CONCLAVE_JUDGE_IS_MEMBER'));
  assert.equal(compose({ models: [DS, QW], judge: DS, allowJudgeMember: true }).judge.full, DS);
});
test('valida opções antes de subir servidor', () => {
  assert.throws(() => validateConclaveOptions({ mode: 'opinion', models: [DS] }), usageCode('CONCLAVE_TOO_FEW_MEMBERS'));
  assert.throws(() => validateConclaveOptions({ quorum: 1 }), usageCode('CONCLAVE_INVALID_QUORUM'));
  assert.throws(() => validateConclaveOptions({ mode: 'debate', rounds: 1 }), usageCode('CONCLAVE_DEBATE_ROUNDS'));
  assert.deepEqual(validateConclaveOptions({ mode: 'debate' }), { rounds: 2 });
});
