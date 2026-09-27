import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CONFIG_USED_FIELDS, diffShapes, evidenceVerdict, lookup, mergeVerdict, shapeOf, toolAttempted } from '../fixtures/contract-shapes.mjs';

test('shapeOf records types, first array element and collapses user-data maps', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', n: null, l: [{ k: true }] }), { a: 'string', b: 'number', l: [{ k: 'boolean' }], n: 'null' });
  assert.deepEqual(shapeOf([]), ['empty']);
  assert.deepEqual(shapeOf({ mcp: { gitlab: { type: 'local' }, other: {} } }, 'config'), { mcp: { '*': { type: 'string' } } });
  assert.deepEqual(shapeOf({}, 'session.status'), { '*': 'empty' });
});

test('config snapshots retain only used fields and redact user-controlled keys at every depth', () => {
  const config = {
    share: 'auto', model: 'private/model', small_model: 'private/small',
    mcp: { 'hive-alice': { type: 'local' } },
    agent: { build: { permission: { bash: { '*> $HOME/.*': 'deny', '/home/alice/bin*': 'allow' } } } },
    provider: { 'omniroute-alice': { models: { 'private/model': { name: 'private value' } } } },
    permission: { nested: { '/home/alice/bin*': 'deny' } },
    unrelated: { alice: 'private value' },
  };
  const shape = shapeOf(config, 'config');
  const serialized = JSON.stringify(shape);
  for (const personal of ['alice', '/home', 'HOME', 'hive', 'omniroute', 'private value']) assert.equal(serialized.includes(personal), false, personal);
  assert.deepEqual(Object.keys(shape).sort(), CONFIG_USED_FIELDS.filter((field) => Object.hasOwn(config, field)).sort());
  for (const field of CONFIG_USED_FIELDS) assert.ok(Object.hasOwn(shape, field), `${field} missing from shape`);
  assert.equal(shape.share, 'string');
  assert.deepEqual(shape.mcp, { '*': { type: 'string' } });
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
  const reason = 'o modelo não tentou a ferramenta';
  assert.equal(evidenceVerdict(toolAttempted([], [], 'bash'), true, reason), `INCONCLUSIVO (${reason})`);
  assert.equal(toolAttempted([{ tool: 'bash', status: 'error' }], [], 'bash'), true);
  assert.equal(toolAttempted([], [{ permission: 'bash' }], 'bash'), true);
  assert.equal(evidenceVerdict(true, true), 'DENY');
  assert.throws(() => evidenceVerdict(false, true), /motivo/i);
  assert.equal(evidenceVerdict(false, true, reason), `INCONCLUSIVO (${reason})`);
});

test('merge verdict requires a surviving pre-existing effective config value', () => {
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { model: 'private/model' }, overridePresent: true }), { verdict: 'MERGE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { share: 'disabled' }, overridePresent: true }), { verdict: 'REPLACE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true, reason: 'nenhuma chave de config do usuário para comparar' }), { verdict: 'INCONCLUSIVO (nenhuma chave de config do usuário para comparar)', key: null });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true, reason: 'nenhuma chave de config do usuário para comparar' }), { verdict: 'INCONCLUSIVO (nenhuma chave de config do usuário para comparar)', key: null });
  assert.throws(() => mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: {}, overridePresent: false }), /motivo/i);
});

test('inconclusive MCP and config merge findings carry Portuguese reasons', () => {
  const mcp = evidenceVerdict(false, true, 'o modelo não tentou a ferramenta');
  assert.match(mcp, /^INCONCLUSIVO \(.+\)$/);
  assert.match(mcp, /o modelo não tentou a ferramenta/);
  const merge = mergeVerdict({
    overrideApplied: true,
    userConfig: {},
    effectiveConfig: { share: 'disabled' },
    overridePresent: true,
    reason: 'nenhuma chave de config do usuário para comparar',
  }).verdict;
  assert.match(merge, /^INCONCLUSIVO \(.+\)$/);
  assert.match(merge, /nenhuma chave de config do usuário para comparar/);
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
