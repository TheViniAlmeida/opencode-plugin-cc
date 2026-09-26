import assert from 'node:assert/strict';
import test from 'node:test';

import { diffShapes, lookup, shapeOf } from '../fixtures/contract-shapes.mjs';

test('shapeOf records types, first array element and collapses user-data maps', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', n: null, l: [{ k: true }] }), { a: 'string', b: 'number', l: [{ k: 'boolean' }], n: 'null' });
  assert.deepEqual(shapeOf([]), ['empty']);
  assert.deepEqual(shapeOf({ mcp: { gitlab: { type: 'local' }, other: {} } }, 'config'), { mcp: { '*': { type: 'string' } } });
  assert.deepEqual(shapeOf({}, 'session.status'), { '*': 'empty' });
});

test('lookup walks dotted paths with [] for array elements', () => {
  const shape = shapeOf([{ name: 'build', permission: [{ action: 'allow' }] }]);
  assert.equal(lookup(shape, '[].name'), 'string');
  assert.deepEqual(lookup(shape, '[].permission'), [{ action: 'string' }]);
  assert.equal(lookup(shape, '[].missing'), undefined);
  assert.equal(lookup({ a: 'string' }, '[].a'), undefined);
});

test('diffShapes reports missing and different used fields only', () => {
  const real = shapeOf({ healthy: true, version: '1', extra: 1 });
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: true, version: '1' }), ['healthy', 'version']), []);
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: 'yes', version: '1' }), ['healthy']), [{ field: 'healthy', real: '"boolean"', fake: '"string"' }]);
  assert.equal(diffShapes(shapeOf({}), shapeOf({ version: '1' }), ['version'])[0].real, 'ausente');
  assert.equal(diffShapes(shapeOf([]), shapeOf({}), [])[0].field, '(root)');
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({}), [], ['share']), []);
  assert.deepEqual(diffShapes(shapeOf({ mcp: { a: { type: 'local' } } }, 'config'), shapeOf({ mcp: {} }, 'config'), [], ['mcp']), []);
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({ share: true }), [], ['share']), [{ field: 'share', real: 'string', fake: 'boolean' }]);
});
