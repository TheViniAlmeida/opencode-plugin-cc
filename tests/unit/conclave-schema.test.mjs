import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, buildMemberSchema, buildDebateSchema, buildSynthesisSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { answer, debateAnswer, synthesis } from './_conclave-fixtures.mjs';

const SCHEMAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/opc/schemas');
const memberFile = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'conclave-member.schema.json'), 'utf8'));
const synthesisFile = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'conclave-synthesis.schema.json'), 'utf8'));

test('member schema accepts a complete answer, including null evidence lines', () => {
  const schema = buildMemberSchema(memberFile);
  assert.deepEqual(validateSchema(answer(), schema), []);
  const wholeFile = answer({ evidence: [{ file: 'README.md', line_start: null, line_end: null, note: 'whole file' }] });
  assert.deepEqual(validateSchema(wholeFile, schema), []);
});

test('member schema rejects out-of-range confidence, missing and extra fields', () => {
  const schema = buildMemberSchema(memberFile);
  const paths = (v) => validateSchema(v, schema).map((e) => e.path);
  assert.deepEqual(paths(answer({ confidence: 1.7 })), ['$.confidence']);
  const missing = answer();
  delete missing.risks;
  assert.deepEqual(paths(missing), ['$.risks']);
  assert.deepEqual(paths(answer({ model: 'x' })), ['$.model']);
  assert.deepEqual(paths(answer({ evidence: [{ file: 'a.js', line_start: 0, line_end: 2, note: '' }] })), ['$.evidence[0].line_start']);
});

test('member schema sent to providers has no $schema or $defs', () => {
  const schema = buildMemberSchema(memberFile);
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$defs, undefined);
  assert.equal(schema.title, 'ConclaveMember');
  assert.ok(memberFile.$defs.debateExtension, 'source file keeps the debate extension');
});

test('debate schema extends the member schema with critiques and changed, target limited to peers', () => {
  const schema = buildDebateSchema(memberFile, ['B', 'C']);
  assert.equal(schema.title, 'ConclaveDebate');
  assert.ok(schema.required.includes('critiques'));
  assert.ok(schema.required.includes('changed'));
  assert.deepEqual(validateSchema(debateAnswer('B'), schema), []);
  assert.deepEqual(validateSchema(debateAnswer('A'), schema).map((e) => e.path), ['$.critiques[0].target']);
  const noChanged = debateAnswer('B');
  delete noChanged.changed;
  assert.deepEqual(validateSchema(noChanged, schema).map((e) => e.path), ['$.changed']);
  assert.deepEqual(validateSchema(answer(), schema).map((e) => e.path).sort(), ['$.changed', '$.critiques']);
});

test('debate schema does not mutate the source schema', () => {
  buildDebateSchema(memberFile, ['B']);
  assert.equal(memberFile.$defs.debateExtension.properties.critiques.items.properties.target.enum, undefined);
  assert.equal(memberFile.properties.critiques, undefined);
});

test('synthesis schema validates judge output and restricts members to labels', () => {
  const schema = buildSynthesisSchema(synthesisFile, ['A', 'B', 'C']);
  assert.equal(schema.title, 'ConclaveSynthesis');
  assert.deepEqual(validateSchema(synthesis(['A', 'B', 'C']), schema), []);
  const bad = synthesis(['A', 'B', 'C'], { minority_reports: [{ members: ['Z'], summary: 'x' }] });
  assert.deepEqual(validateSchema(bad, schema).map((e) => e.path), ['$.minority_reports[0].members[0]']);
  assert.deepEqual(validateSchema(synthesis(['A', 'B', 'C'], { confidence: 1.5 }), schema).map((e) => e.path), ['$.confidence']);
});

test('validateSchema handles type unions, enums and integer vs number', () => {
  assert.deepEqual(validateSchema(3, { type: 'integer' }), []);
  assert.equal(validateSchema(3.5, { type: 'integer' }).length, 1);
  assert.deepEqual(validateSchema(3, { type: 'number' }), []);
  assert.deepEqual(validateSchema(null, { type: ['integer', 'null'], minimum: 1 }), []);
  assert.equal(validateSchema('x', { enum: ['a', 'b'] }).length, 1);
  assert.equal(validateSchema([], { type: 'array', minItems: 1 }).length, 1);
});
