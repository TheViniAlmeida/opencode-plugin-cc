import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractSample } from '../fixtures/contract-shapes.mjs';
import {
  globToRegExp, matchesAny, parseFullId, buildCatalog, expandAlias, normalizeModelId,
  resolveModelRef, validateVariant, searchModels,
} from '../../plugins/opc/scripts/lib/models.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
const providers = JSON.parse(fs.readFileSync(path.join(DATA, 'provider.json'), 'utf8'));
const catalog = buildCatalog({ providers, models: JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8')), defaultModel: { providerID: 'omniroute-personal', id: 'opencode-go/deepseek-v4.1-flash' } });
const MV = 'omniroute-personal';

test('buildCatalog reads the V2 provider, model and default lists', () => {
  const catalog = buildCatalog({
    providers: loadContractSample('provider.json').data,
    models: loadContractSample('model.json').data,
    defaultModel: loadContractSample('model-default.json').data,
  });
  const entry = catalog.byFull.get('omniroute-personal/opencode-go/deepseek-v4.1-flash');
  assert.ok(entry);
  assert.deepEqual(entry.variants, ['low', 'medium', 'high']);
  assert.ok(!JSON.stringify(catalog).includes('fake-provider-key'));
  assert.ok(catalog.connected.has('omniroute-personal'));
});

test('globToRegExp: * matches any sequence including slashes', () => {
  assert.ok(globToRegExp('omniroute-personal/*').test('omniroute-personal/opencode-go/kimi-k3'));
  assert.ok(globToRegExp('*/kimi-*').test('omniroute-work/opencode-go/kimi-k3'));
  assert.ok(!globToRegExp('anthropic/*').test('omniroute-personal/anthropic/x'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dots are literal');
  assert.ok(globToRegExp('work-*').test('work-deploy'));
});

test('globToRegExp: adversarial stars and directory globs finish within 50 ms', () => {
  const script = `
    import { globToRegExp, matchesAny } from ${JSON.stringify(new URL('../../plugins/opc/scripts/lib/models.mjs', import.meta.url).href)};
    const start = performance.now();
    const results = [
      globToRegExp('*'.repeat(64) + 'x').test('.env'),
      globToRegExp('*a'.repeat(64) + 'x').test('a'.repeat(128)),
      globToRegExp('**/a/'.repeat(64) + 'x').test('a/'.repeat(128)),
      matchesAny('.env', ['*'.repeat(64) + 'env']),
    ];
    console.log(JSON.stringify({ results, elapsed: performance.now() - start }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 }));
  assert.deepEqual(result.results, [false, false, false, true]);
  assert.ok(result.elapsed < 50, `${result.elapsed} ms`);
});

test('globToRegExp: interior stars preserve suffix and optional directory matching', () => {
  for (const [glob, value, expected] of [
    ['*a*b', 'aab', true], ['*a*a', 'aa', true], ['*a*a', 'ab', false],
    ['**/a/**/b', 'a/a/b', true], ['**/a/**/b', 'a/x/b', true],
    ['**/a*b', 'dir/aab', true], ['**/a*b', 'xaaab', false],
    ['**/b*/*', 'b?/b??aa?', true], ['**/a*/*', 'a/a', true],
    ['**/*a', 'xa', true], ['a/**/**/b', 'a/b', true], ['a/**/**/b', 'a/x/y/b', true],
    ['*?[]', 'x?[]', true], ['*?[]', 'xab', false],
  ]) assert.equal(globToRegExp(glob).test(value), expected, `${glob}: ${value}`);
  assert.ok(globToRegExp('*a*b') instanceof RegExp);
});

test('matchesAny: empty list never matches', () => {
  assert.equal(matchesAny('x', []), false);
  assert.equal(matchesAny('x', undefined), false);
  assert.equal(matchesAny('work-reviewer', ['build', 'work-*']), true);
});

test('matchesAny: repeated matching remains correct after more than 512 distinct globs', () => {
  for (let i = 0; i < 600; i += 1) {
    const globs = [`synthetic-${i}/*`];
    assert.equal(matchesAny(`synthetic-${i}/model`, globs), true);
    assert.equal(matchesAny('other/model', globs), false);
  }
  for (let i = 0; i < 2; i += 1) {
    assert.equal(matchesAny('synthetic-0/model', ['synthetic-0/*']), true);
    assert.equal(matchesAny('other/model', ['synthetic-0/*']), false);
    assert.equal(matchesAny('id_rsa', ['**/id_rsa*']), true);
    assert.equal(matchesAny('src/main.js', ['**/id_rsa*']), false);
  }
});

test('globToRegExp: LRU retains recently used entries and evicts at 4096 globs', () => {
  const hot = globToRegExp('synthetic-lru-hot/*');
  const cold = globToRegExp('synthetic-lru-cold/*');
  for (let i = 0; i < 4094; i += 1) globToRegExp(`synthetic-lru-${i}/*`);
  assert.equal(globToRegExp('synthetic-lru-hot/*'), hot);
  globToRegExp('synthetic-lru-overflow/*');
  assert.equal(globToRegExp('synthetic-lru-hot/*'), hot);
  assert.notEqual(globToRegExp('synthetic-lru-cold/*'), cold);
  assert.equal(matchesAny('synthetic-lru-cold/model', ['synthetic-lru-cold/*']), true);
});

test('matchesAny: 600 distinct globs across 2000 words finish within one second', (t) => {
  const script = `
    import { matchesAny } from ${JSON.stringify(new URL('../../plugins/opc/scripts/lib/models.mjs', import.meta.url).href)};
    const globs = Array.from({ length: 600 }, (_, i) => 'synthetic-perf-' + i + '/*');
    const start = performance.now();
    let matched = 0;
    for (let i = 0; i < 2000; i += 1) matched += Number(matchesAny('other/word-' + i, globs));
    console.log(JSON.stringify({ matched, elapsed: performance.now() - start }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.matched, 0);
  assert.ok(result.elapsed < 1000, `${result.elapsed} ms`);
  t.diagnostic(`${result.elapsed} ms for 600 globs across 2000 words`);
});

test('globToRegExp: optional **/ directories require a path boundary', () => {
  for (const value of ['b', 'a/b', 'a/nested/b']) assert.ok(globToRegExp('**/b').test(value), value);
  for (const value of ['a/b', 'a/nested/b']) assert.ok(globToRegExp('a/**/b').test(value), value);
  assert.ok(!globToRegExp('a**/b').test('ab'));
  assert.ok(!globToRegExp('a**/b').test('aXYZb'));
  assert.ok(globToRegExp('a**/b').test('a/b'));
  assert.ok(globToRegExp('a**/b').test('aXYZ/b'));
  assert.ok(!globToRegExp('a**/b**/c').test('abc'));
  assert.ok(globToRegExp('**/**/b').test('b'));
  assert.ok(globToRegExp('a/**/**/b').test('a/b'));
});

test('parseFullId: first segment is provider, rest (with slashes) is model', () => {
  assert.deepEqual(parseFullId(`${MV}/opencode-go/deepseek-v4.1-flash`), { providerID: MV, modelID: 'opencode-go/deepseek-v4.1-flash' });
  assert.deepEqual(parseFullId('kimi-k3'), { providerID: null, modelID: 'kimi-k3' });
});

test('buildCatalog: connected set, models with full ids, variants, providers summary', () => {
  assert.ok(catalog.connected.has(MV));
  assert.ok(!catalog.connected.has('openai'));
  const kimi = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(kimi.variants, ['low', 'medium', 'high']);
  assert.deepEqual(kimi.limit, { context: 262144, output: 32768 });
  assert.equal(kimi.connected, true);
  const mv = catalog.providers.find((p) => p.id === MV);
  assert.equal(mv.modelCount, 7);
  assert.equal(mv.defaultModel, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.ok(!JSON.stringify(catalog.models).includes('FIXTURE'), 'catalog never carries keys/headers');
});

test('expandAlias: one level only', () => {
  const aliases = { fast: `${MV}/opencode-go/deepseek-v4.1-flash`, loop: 'fast' };
  assert.equal(expandAlias('fast', aliases), `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(expandAlias('loop', aliases), 'fast');
  assert.equal(expandAlias('other', aliases), 'other');
});

test('normalizeModelId: full id with slashes stays intact', () => {
  const r = normalizeModelId(`${MV}/opencode-go/deepseek-v4.1-flash`, { catalog, defaultProvider: MV });
  assert.equal(r.full, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(r.providerID, MV);
  assert.equal(r.modelID, 'opencode-go/deepseek-v4.1-flash');
});

test('normalizeModelId: short name gets defaultProvider prefix', () => {
  assert.equal(normalizeModelId('opencode-go/kimi-k3', { catalog, defaultProvider: MV }).full, `${MV}/opencode-go/kimi-k3`);
});

test('normalizeModelId: both readings valid is AMBIGUOUS_MODEL', () => {
  assert.throws(() => normalizeModelId('opencode/big-pickle', { catalog, defaultProvider: MV }), (err) => {
    assert.equal(err.code, 'AMBIGUOUS_MODEL');
    assert.equal(err.exitCode, 2);
    assert.equal(err.details.inputPreview, 'opencode/big…');
    assert.equal(Object.hasOwn(err.details, 'input'), false);
    assert.deepEqual(err.details.candidates, ['opencode/big-pickle', `${MV}/opencode/big-pickle`]);
    return true;
  });
});

test('normalizeModelId: "=" prefix and fullOnly force the full reading', () => {
  assert.equal(normalizeModelId('=opencode/big-pickle', { catalog, defaultProvider: MV }).full, 'opencode/big-pickle');
  assert.equal(normalizeModelId('opencode/big-pickle', { catalog, defaultProvider: MV, fullOnly: true }).full, 'opencode/big-pickle');
  assert.equal(normalizeModelId(`${MV}/opencode/big-pickle`, { catalog, defaultProvider: MV }).full, `${MV}/opencode/big-pickle`);
});

test('normalizeModelId: alias expands and resolves as full id', () => {
  const aliases = { pickle: 'opencode/big-pickle' };
  assert.equal(normalizeModelId('pickle', { catalog, defaultProvider: MV, aliases }).full, 'opencode/big-pickle');
});

test('normalizeModelId: unknown model and disconnected provider', () => {
  assert.throws(() => normalizeModelId('nope-model', { catalog, defaultProvider: MV }), (err) => {
    assert.equal(err.code, 'UNKNOWN_MODEL');
    assert.match(err.message, /modelo desconhecido/);
    return err.exitCode === 2;
  });
  assert.throws(() => normalizeModelId('openai/gpt-5.6', { catalog }), (err) => {
    assert.equal(err.code, 'UNKNOWN_MODEL');
    assert.match(err.message, /não está conectado/);
    assert.doesNotMatch(err.message, /not connected/);
    return true;
  });
  assert.throws(() => normalizeModelId('   ', { catalog }), (err) => err.code === 'UNKNOWN_MODEL' && /identificador de modelo vazio/.test(err.message));
  const oversized = 'x'.repeat(80);
  assert.throws(() => normalizeModelId(oversized, { catalog }), (err) => {
    assert.equal(err.code, 'UNKNOWN_MODEL');
    assert.match(err.message, /modelo desconhecido "xxxxxxxxxxxx…"/);
    assert.equal(err.message.includes(oversized), false);
    assert.deepEqual(err.details, { inputPreview: 'xxxxxxxxxxxx…', suggestions: [] });
    assert.equal(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }).includes(oversized), false);
    return true;
  });
});

test('validateVariant: invalid variant message is Brazilian Portuguese', () => {
  const entry = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  assert.throws(() => validateVariant(entry, 'turbo'), (err) => {
    assert.equal(err.code, 'UNKNOWN_VARIANT');
    assert.match(err.message, /variante .* não é válida/);
    return true;
  });
});

test('normalizeModelId: suggestions on unknown model', () => {
  assert.throws(() => normalizeModelId('kimi-k3', { catalog, defaultProvider: MV }), (err) => {
    assert.ok(err.details.suggestions.includes(`${MV}/opencode-go/kimi-k3`));
    return true;
  });
});

test('resolveModelRef: keeps alias names, normalizes models, accepts claude when allowed', () => {
  const aliases = { strong: `${MV}/opencode-go/qwen3.8-max` };
  assert.deepEqual(resolveModelRef('strong', { catalog, aliases, defaultProvider: MV }), { kind: 'alias', value: 'strong', full: `${MV}/opencode-go/qwen3.8-max` });
  assert.equal(resolveModelRef('opencode-go/kimi-k3', { catalog, aliases, defaultProvider: MV }).value, `${MV}/opencode-go/kimi-k3`);
  assert.equal(resolveModelRef('claude', { catalog, allowClaude: true }).kind, 'claude');
  assert.throws(() => resolveModelRef('claude', { catalog }), (err) => err.code === 'UNKNOWN_MODEL');
});

test('validateVariant: accepts known, rejects unknown', () => {
  const kimi = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  assert.equal(validateVariant(kimi, 'high'), 'high');
  assert.equal(validateVariant(kimi, null), null);
  assert.throws(() => validateVariant(kimi, 'ultra'), (err) => err.code === 'UNKNOWN_VARIANT' && err.exitCode === 2);
});

test('searchModels: glob and substring, provider filter', () => {
  assert.deepEqual(searchModels(catalog, 'opencode-go/qwen*', { providerID: MV }).map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`]);
  assert.ok(searchModels(catalog, 'kimi').every((m) => m.connected));
  assert.equal(searchModels(catalog, 'gpt-5.6', { connectedOnly: false }).some((m) => m.providerID === 'openai'), true);
});

test('invalid variant keeps only a preview of user input', () => {
  const entry = catalog.byFull.get(`${MV}/opencode-go/kimi-k3`);
  const input = 'invalid-variant-' + 'x'.repeat(60);
  assert.throws(() => validateVariant(entry, input), (err) => {
    assert.equal(err.code, 'UNKNOWN_VARIANT');
    assert.deepEqual(err.details, { model: entry.full, variantPreview: 'invalid-vari…', valid: entry.variants });
    assert.equal(JSON.stringify({ message: err.message, details: err.details }).includes(input), false);
    return true;
  });
});
