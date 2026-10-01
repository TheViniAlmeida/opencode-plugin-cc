import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateInput } from '../../plugins/opc/scripts/lib/mcp-schema.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^per[A-Za-z0-9_]*$', maxLength: 10 },
    reply: { type: 'string', enum: ['once', 'reject'] },
    n: { type: 'integer', minimum: 1, maximum: 3 },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } },
    flag: { type: 'boolean' },
  },
  required: ['id', 'reply'],
  additionalProperties: false,
};

test('valid input yields no errors', () => {
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_1', reply: 'once', n: 2, tags: ['a'], flag: true }), []);
});

test('each violation is reported with its path', () => {
  const errors = validateInput(SCHEMA, { id: 'bad', reply: 'always', n: 4, tags: [], flag: 'yes', extra: 1 });
  assert.deepEqual(errors, [
    '$.id: formato inválido',
    '$.reply: valor fora das opções permitidas',
    '$.n: acima de 3',
    '$.tags: quantidade de itens inferior a 1',
    '$.flag: esperado boolean',
    '$.extra…: propriedade desconhecida',
  ]);
});

test('required keys, wrong root type, item validation, integer and length checks', () => {
  assert.deepEqual(validateInput(SCHEMA, {}), ['$.id: é obrigatório', '$.reply: é obrigatório']);
  assert.deepEqual(validateInput(SCHEMA, []), ['$: esperado object']);
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_1', reply: 'once', tags: ['', 'b', 'c'] }), ['$.tags: mais de 2 itens', '$.tags[0]: comprimento inferior a 1']);
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_123456789', reply: 'once', n: 1.5 }), ['$.id: mais de 10 caracteres', '$.n: esperado integer']);
});

test('remaining bounds, finite numbers, custom paths and unknown keys', () => {
  assert.deepEqual(validateInput({ type: 'number', minimum: 1, maximum: 3 }, 0, '$.quantity'), ['$.quantity: abaixo de 1']);
  assert.deepEqual(validateInput({ type: 'number' }, Infinity), ['$: esperado number']);
  assert.deepEqual(validateInput({ type: 'string', minLength: 1 }, ''), ['$: comprimento inferior a 1']);
  assert.deepEqual(validateInput(SCHEMA, { id: 'per_1', reply: 'once', sensitiveUnknownProperty: true }), ['$.sensitiveUnk…: propriedade desconhecida']);
});

test('inherited keys do not satisfy required fields', () => {
  assert.deepEqual(validateInput({ type: 'object', required: ['toString'] }, {}), ['$.toString: é obrigatório']);
});
