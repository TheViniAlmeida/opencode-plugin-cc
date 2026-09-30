import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFindings, titleSimilarity, titleTokens } from '../../plugins/opc/scripts/lib/conclave.mjs';

const f = (file, line_start, line_end, title, severity = 'medium', confidence = 0.5, extra = {}) => ({
  severity, title, body: `${title} body`, file, line_start, line_end, confidence, recommendation: `fix ${title}`, ...extra,
});

test('titleTokens lowercases, strips accents, drops stopwords and 1-char tokens', () => {
  assert.deepEqual([...titleTokens('Division by zero when count is 0')].sort(), ['count', 'division', 'zero']);
  assert.deepEqual([...titleTokens('Divisão por zero na função')].sort(), ['divisao', 'funcao', 'zero']);
});

test('titleSimilarity is token Jaccard', () => {
  assert.equal(titleSimilarity('Division by zero when count is 0', 'Possible division by zero on empty count'), 3 / 5);
  assert.equal(titleSimilarity('Off-by-one in loop bound', 'Null pointer in parser'), 0);
  assert.equal(titleSimilarity('', 'anything'), 0);
});

test('same file, nearby lines and similar titles form one cluster with k/N agreement', () => {
  const clusters = clusterFindings({
    A: [f('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9)],
    B: [f('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7)],
    C: [],
  });
  assert.equal(clusters.length, 1);
  const [c] = clusters;
  assert.equal(c.id, 'C1');
  assert.deepEqual(c.agreement, { k: 2, n: 3, text: '2/3' });
  assert.deepEqual(c.labels, ['A', 'B']);
  assert.equal(c.severity, 'critical');
  assert.equal(c.meanConfidence, 0.8);
  assert.equal(c.bestLabel, 'A');
  assert.equal(c.title, 'Division by zero when count is 0');
  assert.equal(c.body, 'Division by zero when count is 0 body');
  assert.equal(c.line_start, 10);
  assert.equal(c.line_end, 14);
  assert.equal(c.findings.length, 2);
});

test('lines more than 3 apart are not clustered even with identical titles', () => {
  const clusters = clusterFindings({ A: [f('src/calc.js', 10, 14, 'Division by zero when count is 0')], B: [f('src/calc.js', 18, 20, 'Division by zero when count is 0')] });
  assert.equal(clusters.length, 2);
  const within = clusterFindings({ A: [f('src/calc.js', 10, 14, 'Division by zero when count is 0')], B: [f('src/calc.js', 17, 20, 'Division by zero when count is 0')] });
  assert.equal(within.length, 1, 'a gap of exactly 3 lines still clusters');
});

test('dissimilar titles at the same place are not clustered', () => {
  assert.equal(clusterFindings({ A: [f('src/list.js', 5, 5, 'Off-by-one in loop bound')], B: [f('src/list.js', 5, 6, 'Null pointer in parser')] }).length, 2);
});

test('different files are never clustered', () => {
  assert.equal(clusterFindings({ A: [f('src/a.js', 1, 2, 'Missing input validation')], B: [f('src/b.js', 1, 2, 'Missing input validation')] }).length, 2);
});

test('findings without file are never clustered and count as k=1', () => {
  const clusters = clusterFindings({
    A: [f('', 1, 1, 'Missing tests for calc module', 'low'), f('N/A', 1, 1, 'Missing tests for calc module', 'low')],
    B: [f(null, 1, 1, 'Missing tests for calc module', 'low'), f(' - ', 1, 1, 'Missing tests for calc module', 'low'), { severity: 'low', title: 'Missing tests for calc module', body: 'x', confidence: 0.3 }],
  });
  assert.equal(clusters.length, 5);
  assert.ok(clusters.every((c) => c.file === null && c.agreement.k === 1 && c.agreement.text === '1/2'));
});

test('malformed line numbers are normalized instead of crashing', () => {
  const clusters = clusterFindings({
    A: [f('./src/x.js', 20, 10, 'Race condition on cache refresh')],
    B: [f('src\\x.js', '12', null, 'Cache refresh race condition')],
    C: [f('src/x.js', null, undefined, 'Race condition on cache refresh')],
  });
  const joined = clusters.find((c) => c.labels.length === 2);
  assert.ok(joined);
  assert.deepEqual(joined.labels, ['A', 'B']);
  assert.equal(joined.line_start, 10);
  assert.equal(joined.line_end, 20);
  assert.equal(clusters.find((c) => c.labels.includes('C')).agreement.k, 1);
});

test('internal dot and repeated slash path segments normalize before clustering', () => {
  const clusters = clusterFindings({
    A: [f('src/./calc.js', 4, 4, 'Division by zero in calculation')],
    B: [f('./src/calc.js', 4, 4, 'Division by zero in calculation')],
    C: [f('src\\calc.js', 4, 4, 'Division by zero in calculation')],
    D: [f('src//calc.js', 4, 4, 'Division by zero in calculation')],
  });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].labels, ['A', 'B', 'C', 'D']);
  assert.equal(clusters[0].file, 'src/calc.js');
});

test('paths escaping the root keep normalized form without throwing', () => {
  const clusters = clusterFindings({ A: [f('src/../../calc.js', 1, 1, 'Missing validation')] });
  assert.equal(clusters[0].file, '../calc.js');
});

test('two findings without lines in the same file cluster when titles match', () => {
  const clusters = clusterFindings({ A: [f('README.md', null, null, 'Outdated install instructions')], B: [f('README.md', undefined, undefined, 'Install instructions are outdated')] });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].line_start, null);
});

test('clusters are sorted by every comparator criterion in order', () => {
  const clusters = clusterFindings({
    A: [
      f('same.js', 20, 20, 'Alpha', 'high', 0.8),
      f('same.js', 10, 10, 'Bravo', 'high', 0.8),
      f('confidence.js', 1, 1, 'Confidence low', 'high', 0.5),
      f('z.js', 1, 1, 'Location Z', 'high', 0.8),
      f('a.js', 1, 1, 'Location A', 'high', 0.8),
      f('agreement low', 1, 1, 'Agreement low', 'high', 0.8),
      f('severity-medium.js', 1, 1, 'Severity medium', 'medium', 0.8),
      f('severity-critical.js', 1, 1, 'Severity critical', 'critical', 0.8),
    ],
    B: [
      f('confidence.js', 1, 1, 'Confidence low', 'high', 0.8),
      f('z.js', 1, 1, 'Location Z', 'high', 0.8),
      f('a.js', 1, 1, 'Location A', 'high', 0.8),
      f('severity-medium.js', 1, 1, 'Severity medium', 'medium', 0.8),
      f('severity-critical.js', 1, 1, 'Severity critical', 'critical', 0.8),
    ],
  });
  assert.deepEqual(clusters.map((c) => c.title), [
    'Severity critical', 'Location A', 'Location Z', 'Confidence low', 'Agreement low', 'Bravo', 'Alpha', 'Severity medium',
  ]);
});

test('N comes from validCount when given', () => {
  assert.equal(clusterFindings({ A: [f('a.js', 1, 1, 'Something wrong')] }, { validCount: 4 })[0].agreement.text, '1/4');
});

test('a member repeating the same finding still counts once', () => {
  const clusters = clusterFindings({ A: [f('a.js', 1, 2, 'SQL injection in query builder', 'high', 0.6), f('a.js', 2, 3, 'SQL injection in the query builder', 'high', 0.8)], B: [] });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].agreement.k, 1);
  assert.equal(clusters[0].meanConfidence, 0.7);
});
