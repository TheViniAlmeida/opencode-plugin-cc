import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { diffShapes, evidenceVerdict, lookup, mergeVerdict, shapeOf, toolAttempted } from '../fixtures/contract-shapes.mjs';

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

test('probe verdicts require a tool attempt in the same turn', () => {
  assert.equal(toolAttempted([], [], 'bash'), false);
  assert.equal(evidenceVerdict(toolAttempted([], [], 'bash'), true), 'INCONCLUSIVE (model did not attempt the tool)');
  assert.equal(toolAttempted([{ tool: 'bash', status: 'error' }], [], 'bash'), true);
  assert.equal(toolAttempted([], [{ permission: 'bash' }], 'bash'), true);
  assert.equal(evidenceVerdict(true, true), 'DENY');
  assert.throws(() => evidenceVerdict(false, true), /reason/i);
  assert.equal(evidenceVerdict(false, true, 'o modelo não tentou a ferramenta'), 'INCONCLUSIVO (o modelo não tentou a ferramenta)');
});

test('merge verdict requires a surviving pre-existing effective config value', () => {
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { model: 'private/model' }, overridePresent: true }), { verdict: 'MERGE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { share: 'disabled' }, overridePresent: true }), { verdict: 'REPLACE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true }), { verdict: 'INCONCLUSIVE', key: null });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true, reason: 'nenhuma chave de config do usuário para comparar' }), { verdict: 'INCONCLUSIVO (nenhuma chave de config do usuário para comparar)', key: null });
  assert.throws(() => mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: {}, overridePresent: false }), /reason/i);
});

test('inconclusive MCP and config merge findings carry Portuguese reasons', () => {
  const probe = fs.readFileSync(path.resolve('tests/live/probe-permission-precedence.mjs'), 'utf8');
  assert.match(probe, /denyAttempted\s*\?[^:]+:\s*'INCONCLUSIVO \(o modelo não tentou a ferramenta\)'/);
  assert.match(probe, /reason:\s*'ferramenta MCP injetada não apareceu'/);
  assert.match(probe, /reason:\s*mergeReason/);
  assert.match(probe, /GET \/config falhou/);
});

test('live diagnostics redact output and connection cleanup stops before tracked temp removal', () => {
  const root = path.resolve('tests/live');
  const probe = fs.readFileSync(path.join(root, 'probe-permission-precedence.mjs'), 'utf8');
  const connection = fs.readFileSync(path.join(root, 'f0-connection.mjs'), 'utf8');
  assert.match(probe, /process\.stderr\.write\(redactText\(/);
  assert.match(probe, /process\.stdout\.write\(redactText\(/);
  assert.match(probe, /toolAttempted\(deny\.tools, deny\.asked, toolId\)/);
  assert.match(probe, /approvedInA[\s\S]*?a\.tools\.some/);
  assert.match(connection, /trackTempDir\(t, makeTempDir\(/);
  assert.match(connection, /registerStopper\(t, \(\) => stopServer\(cleanupCtx/);
});

test('contract collection deadline uses monotonic performance time', () => {
  const source = fs.readFileSync(path.resolve('tests/live/contract.mjs'), 'utf8');
  assert.match(source, /const deadline = performance\.now\(\) \+ 15000/);
  assert.match(source, /while \(performance\.now\(\) < deadline/);
  assert.doesNotMatch(source, /const deadline = Date\.now\(\)/);
});
