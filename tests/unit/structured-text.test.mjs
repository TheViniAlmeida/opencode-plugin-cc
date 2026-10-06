import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonInstruction, schemaValidator } from '../../plugins/opc/scripts/lib/structured-text.mjs';

const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };

test('instruction embeds the schema and the validator enforces it', () => {
  assert.match(jsonInstruction(schema), /only one JSON object/);
  assert.match(jsonInstruction(schema), /"required":\["files"\]/);
  const validate = schemaValidator(schema);
  assert.equal(validate({ files: ['a'] }), null);
  assert.equal(typeof validate({ files: 'a' }), 'string');
  assert.equal(typeof validate({ files: [], extra: 1 }), 'string');
});

test('validator accepts nullable fields in product schemas', () => {
  const validate = schemaValidator({ type: 'object', required: ['line'], properties: { line: { type: ['integer', 'null'], minimum: 1 } } });
  assert.equal(validate({ line: 1 }), null);
  assert.equal(validate({ line: null }), null);
  assert.equal(typeof validate({ line: '1' }), 'string');
});
