import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubtaskCandidates, spreadCandidates } from '../../plugins/opc/scripts/lib/orchestrator.mjs';

const P = 'omniroute-personal/opencode-go/';
const FAST = `${P}deepseek-v4.1-flash`;
const STRONG = `${P}qwen3.8-max`;
const K3 = `${P}kimi-k3`;

function catalogOf(fulls) {
  const byFull = new Map(fulls.map((full) => {
    const i = full.indexOf('/');
    return [full, { providerID: full.slice(0, i), modelID: full.slice(i + 1), full }];
  }));
  return { connected: new Set(fulls.map((f) => f.split('/')[0])), models: [...byFull.values()], byFull };
}
const catalog = catalogOf([FAST, STRONG, K3]);
const baseConfig = (routing, policy = {}) => ({
  defaultProvider: 'omniroute-personal',
  aliases: { fast: FAST, strong: STRONG, k3: K3 },
  policy,
  routing,
});
const sub = (extra = {}) => ({ id: 's1', kind: 'ask', tier: null, dependsOn: [], ...extra });

test('tier wins over routing.tasks.<kind>', () => {
  const config = baseConfig({ tasks: { ask: ['fast'] }, tiers: { heavy: ['strong', 'k3'] } });
  const r = resolveSubtaskCandidates(sub({ tier: 'heavy' }), { config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [STRONG, K3]);
  assert.equal(r.candidates[0].source, 'routing.tiers.heavy');
  assert.equal(r.fallbackEligible, true);
});

test('without tier the kind route is used', () => {
  const config = baseConfig({ tasks: { review: ['k3', 'fast'] } });
  const r = resolveSubtaskCandidates(sub({ kind: 'review' }), { config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [K3, FAST]);
  assert.equal(r.source, 'routing.tasks.review');
});

test('empty tier falls back to the kind route with a warning', () => {
  const config = baseConfig({ tasks: { ask: ['fast'] }, tiers: {} });
  const r = resolveSubtaskCandidates(sub({ tier: 'light' }), { config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [FAST]);
  assert.match(r.warnings.join('\n'), /routing\.tiers\.light está vazia; usando routing\.tasks\.ask/);
});

test('no configured list returns null so the caller uses the generic chain', () => {
  assert.equal(resolveSubtaskCandidates(sub(), { config: baseConfig({}), catalog }), null);
});

test('denied and unknown entries are skipped with warnings', () => {
  const config = baseConfig({ tasks: { ask: ['ghost-model', 'k3', 'fast'] } }, { models: { allow: [], deny: ['*kimi*'] } });
  const r = resolveSubtaskCandidates(sub(), { config, catalog });
  assert.deepEqual(r.candidates.map((c) => c.full), [FAST]);
  const w = r.warnings.join('\n');
  assert.match(w, /ignorado ghost-model: modelo desconhecido/);
  assert.match(w, /ignorado k3: negado pela política \(policy\.models\.deny/);
});

test('invalid config entries are masked in reasons and warnings', () => {
  const secretShaped = `sk-proj-${'x'.repeat(40)}`;
  const config = baseConfig({ tasks: { ask: [secretShaped] } });
  const r = resolveSubtaskCandidates(sub(), { config, catalog });
  const output = [...r.reasons, ...r.warnings].join('\n');
  assert.equal(r.candidates.length, 0);
  assert.ok(!output.includes(secretShaped));
  assert.match(output, /\*\*\*/);
});

test('unexpected normalization errors propagate', () => {
  const config = baseConfig({ tasks: { ask: ['fast'] } });
  const malformedCatalog = { ...catalog, connected: null };
  assert.throws(
    () => resolveSubtaskCandidates(sub(), { config, catalog: malformedCatalog }),
    TypeError,
  );
});

test('every entry denied yields no candidates and the reasons (subtask fails, group goes on)', () => {
  const config = baseConfig({ tasks: { ask: ['k3'] } }, { providers: { deny: ['omniroute-personal'] } });
  const r = resolveSubtaskCandidates(sub(), { config, catalog });
  assert.deepEqual(r.candidates, []);
  assert.match(r.reasons[0], /negado pela política \(policy\.providers\.deny/);
});

test('duplicate entries (alias + full id) collapse to one candidate', () => {
  const config = baseConfig({ tasks: { ask: ['fast', FAST] } });
  assert.equal(resolveSubtaskCandidates(sub(), { config, catalog }).candidates.length, 1);
});

const c = (full) => ({ full });

test('spreadCandidates picks the first model not used yet in the group', () => {
  const list = [c('A'), c('B'), c('C')];
  const rr = { next: 0 };
  assert.deepEqual(spreadCandidates(list, new Set(), rr).map((x) => x.full), ['A', 'B', 'C']);
  assert.deepEqual(spreadCandidates(list, new Set(['A']), rr).map((x) => x.full), ['B', 'A', 'C']);
  assert.deepEqual(spreadCandidates(list, new Set(['A', 'B']), rr).map((x) => x.full), ['C', 'A', 'B']);
  assert.equal(rr.next, 0);
});

test('spreadCandidates uses round robin once every candidate was used', () => {
  const list = [c('A'), c('B'), c('C')];
  const used = new Set(['A', 'B', 'C']);
  const rr = { next: 0 };
  assert.equal(spreadCandidates(list, used, rr)[0].full, 'A');
  assert.equal(spreadCandidates(list, used, rr)[0].full, 'B');
  assert.equal(spreadCandidates(list, used, rr)[0].full, 'C');
  assert.equal(spreadCandidates(list, used, rr)[0].full, 'A');
});

test('spreadCandidates with a single candidate returns a copy', () => {
  const list = [c('A')];
  const out = spreadCandidates(list, new Set(['A']), { next: 0 });
  assert.deepEqual(out, list);
  assert.notEqual(out, list);
});
