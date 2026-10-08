import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConclave, buildKnownNames, loadConclaveAssets } from '../../plugins/opc/scripts/lib/conclave.mjs';
import { fillTemplate } from '../../plugins/opc/scripts/lib/prompts.mjs';
import { renderConclave } from '../../plugins/opc/scripts/lib/render.mjs';
import { makeCatalog, MEMBERS, KM, synthesis, ok, failed } from './_conclave-fixtures.mjs';

const realAssets = loadConclaveAssets();
const assets = { ...realAssets, prompts: { ...realAssets.prompts, review: 'Review {{TARGET_LABEL}}\nFocus: {{USER_FOCUS}}\n{{REVIEW_INPUT}}\n{{REVIEW_COLLECTION_GUIDANCE}}' } };
const knownNames = buildKnownNames(makeCatalog());

const finding = (file, line_start, line_end, title, severity, confidence) => ({
  severity, title, body: `${title} explained`, file, line_start, line_end, confidence, recommendation: `Fix: ${title}`,
});
const REVIEWS = {
  A: { verdict: 'needs-attention', summary: 'Two issues.', findings: [finding('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9), finding('', 0, 0, 'Missing tests for calc module', 'low', 0.5)], next_steps: ['Add a guard.'] },
  B: { verdict: 'needs-attention', summary: 'One issue.', findings: [finding('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7)], next_steps: ['Guard count.'] },
  C: { verdict: 'approve', summary: 'Looks fine.', findings: [], next_steps: [] },
};
const CONTEXT = { label: 'working tree diff', summary: '1 file changed', content: 'diff --git a/src/calc.js b/src/calc.js', truncated: false, files: ['src/calc.js'] };

function harness(respond, { judge = { type: 'claude' }, quorum = 2, collectReview = async () => CONTEXT, promptAssets = assets, structuredOutput } = {}) {
  const calls = [];
  let collected = 0;
  const deps = {
    assets: promptAssets,
    knownNames,
    now: () => 0,
    collectReview: async () => { collected += 1; return collectReview(); },
    turn: async (spec) => { calls.push(spec); return respond(spec); },
  };
  const flags = { mode: 'review', rounds: 1, quorum, members: MEMBERS, judge, maxParallel: 4, warnings: [] };
  return { calls, deps, collected: () => collected, run: (q = '') => runConclave({ ctx: { config: structuredOutput ? { conclave: { structuredOutput } } : {} }, question: q, flags, deps }) };
}

test('review mode collects the diff once and sends the same review prompt and schema to every member', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  await h.run('focus on math');
  assert.equal(h.collected(), 1);
  assert.equal(h.calls.length, 3);
  const prompts = new Set(h.calls.map((c) => c.prompt));
  assert.equal(prompts.size, 1);
  const [prompt] = prompts;
  assert.match(prompt, /Review working tree diff/);
  assert.match(prompt, /Focus: focus on math/);
  assert.match(prompt, /diff --git a\/src\/calc\.js/);
  assert.match(prompt, /The complete diff is included above\./);
  assert.doesNotMatch(prompt, /<user_focus>/);
  assert.ok(h.calls.every((c) => c.schema.properties.findings && c.schema.$schema === undefined));
});

test('review verdict enums and reasons remain structural when they collide with known model names', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  h.deps.knownNames = { exact: ['approve', 'needs-attention', 'attention'], families: [] };
  const pkg = await h.run();
  assert.deepEqual(pkg.review.memberVerdicts, { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
  assert.equal(pkg.review.verdict, 'needs-attention');
  assert.doesNotMatch(JSON.stringify(pkg.review.reasons), /\[redacted\]/);
  const rendered = renderConclave(pkg);
  const table = rendered.slice(rendered.indexOf('## Veredito por membro'));
  assert.match(table, /\| A \| needs-attention \|/);
  assert.match(table, /\| C \| approve \|/);
  assert.doesNotMatch(table, /\[redacted\]/);
});

test('review prompts include the text structured output contract and review schema', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  await h.run();
  const [prompt] = new Set(h.calls.map((c) => c.prompt));
  assert.match(prompt, /Reply with only one JSON object, no prose and no code fence/);
  assert.match(prompt, /validates against this JSON Schema:/);
  assert.match(prompt, /Return a JSON instance with field values, not the schema\./);
  assert.match(prompt, /"findings"/);
});

for (const mode of ['text', 'tool']) {
  test(`${mode} accepts schema-shaped review values before clustering`, async () => {
    const turns = [];
    const h = harness((spec) => {
      const wrapped = { title: spec.schema.title, properties: REVIEWS[spec.label] };
      const turn = Object.freeze({ ...ok(wrapped, `ses_${spec.label}`), finalText: JSON.stringify(wrapped) });
      turns.push(turn);
      return turn;
    }, { structuredOutput: mode });
    const pkg = await h.run();
    assert.equal(pkg.status, 'completed');
    assert.deepEqual(pkg.failures, []);
    assert.equal(pkg.review.validMembers, 3);
    assert.equal(pkg.review.clusters.length, 2);
    assert.deepEqual(pkg.final.responses.map((r) => r.response), Object.values(REVIEWS));
    for (const turn of turns) assert.equal(turn.finalText, JSON.stringify(turn.structured));
  });
}

test('legacy tool setting still requests V2 text JSON without a code fence', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`), { structuredOutput: 'tool', promptAssets: realAssets });
  await h.run();
  const [prompt] = new Set(h.calls.map((c) => c.prompt));
  assert.match(prompt, /Reply with only one JSON object, no prose and no code fence/);
  assert.doesNotMatch(prompt, /Return your answer only through the structured output|single ```json fence/);
});

test('with the real F2b review prompt (no {{USER_FOCUS}}) the question still reaches the members as <user_focus>', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`), { promptAssets: realAssets });
  await h.run('focus on math');
  const [prompt] = new Set(h.calls.map((c) => c.prompt));
  assert.ok(prompt.includes('focus on math'));
  assert.ok(prompt.includes('diff --git a/src/calc.js'));
  assert.match(prompt, /A finding may omit file, line_start and line_end/);
  assert.doesNotMatch(prompt, /única cerca|Cada achado deve apontar/);
  assert.doesNotMatch(prompt, /\{\{[A-Z0-9_]+\}\}/);
});

test('review mode clusters findings, computes k/N over valid members and the verdict', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`));
  const pkg = await h.run();
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.review.validMembers, 3);
  assert.equal(pkg.review.clusters.length, 2);
  const [top, noFile] = pkg.review.clusters;
  assert.deepEqual([top.severity, top.agreement.text, top.labels, top.meanConfidence], ['critical', '2/3', ['A', 'B'], 0.8]);
  assert.deepEqual([noFile.file, noFile.agreement.text], [null, '1/3']);
  assert.equal(pkg.review.verdict, 'needs-attention');
  assert.deepEqual(pkg.review.reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
  assert.deepEqual(pkg.review.memberVerdicts, { A: 'needs-attention', B: 'needs-attention', C: 'approve' });
});

test('a failed reviewer shrinks N instead of counting as a silent approval', async () => {
  const h = harness((spec) => (spec.label === 'C' ? failed('Timeout') : ok(REVIEWS[spec.label], `ses_${spec.label}`)));
  const pkg = await h.run();
  assert.equal(pkg.review.validMembers, 2);
  assert.equal(pkg.review.clusters[0].agreement.text, '2/2');
  assert.deepEqual(pkg.failures.map((f) => f.label), ['C']);
});

test('findings without a location pass validation even when the review schema requires one', async () => {
  const strictAssets = structuredClone(assets);
  const item = strictAssets.schemas.review.properties.findings.items;
  item.properties.file = { type: 'string', minLength: 1 };
  item.properties.line_start = { type: 'integer', minimum: 1 };
  item.properties.line_end = { type: 'integer', minimum: 1 };
  const noLocation = { severity: 'low', title: 'Missing tests', body: 'No tests cover calc.', confidence: 0.4, recommendation: 'Add tests.' };
  const h = harness((spec) => ok({ ...REVIEWS[spec.label], findings: [...REVIEWS[spec.label].findings, noLocation] }, `ses_${spec.label}`));
  h.deps.assets = strictAssets;
  const pkg = await h.run();
  assert.equal(pkg.failures.length, 0);
  assert.equal(h.calls[0].schema.properties.findings.items.properties.file.minLength, undefined, 'runner receives the schema that accepts unlocated findings');
  assert.equal(h.calls[0].schema.properties.findings.items.required.includes('file'), false);
  assert.equal(pkg.review.clusters.filter((c) => c.file === null).length, 4);
});

test('review quorum not met fails without clusters', async () => {
  const h = harness((spec) => (spec.label === 'A' ? ok(REVIEWS.A, 'ses_A') : failed('InvalidStructuredOutput')));
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.equal(pkg.failure.code, 'QUORUM_NOT_MET');
  assert.equal(pkg.review, null);
});

test('review context failure fails the conclave before any turn', async () => {
  const h = harness(() => { throw new Error('must not run'); }, { collectReview: async () => { throw new Error('not a git repository'); } });
  const pkg = await h.run();
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.failure, { code: 'REVIEW_CONTEXT_FAILED', message: 'not a git repository' });
  assert.equal(h.calls.length, 0);
});

test('truncated diffs tell reviewers to read the changed files', async () => {
  const h = harness((spec) => ok(REVIEWS[spec.label], `ses_${spec.label}`), { collectReview: async () => ({ ...CONTEXT, truncated: true }) });
  await h.run();
  assert.match(h.calls[0].prompt, /truncated to fit/);
});

test('judge model in review mode receives anonymized clusters', async () => {
  const judge = { type: 'model', providerID: 'omniroute-personal', modelID: 'opencode-go/kimi-k3', full: KM };
  const reviews = { ...REVIEWS, A: { ...REVIEWS.A, findings: [finding('src/calc.js', 10, 12, 'Division by zero when count is 0 (qwen3.8-max agrees)', 'high', 0.9)] } };
  const h = harness((spec) => (spec.role === 'judge' ? ok(synthesis(['A', 'B', 'C']), 'ses_j') : ok(reviews[spec.label], `ses_${spec.label}`)), { judge });
  const pkg = await h.run();
  const judgeCall = h.calls.find((c) => c.role === 'judge');
  assert.match(judgeCall.prompt, /<mode>review<\/mode>/);
  assert.match(judgeCall.prompt, /<question>\nCode review of working tree diff\n<\/question>/);
  assert.match(judgeCall.prompt, /"agreement": "2\/3"/);
  assert.doesNotMatch(judgeCall.prompt, /qwen/i);
  assert.equal(pkg.judge.status, 'completed');
  assert.doesNotMatch(JSON.stringify(pkg.synthesisInput.review), /qwen/i);
});

test('the review prompt shipped by F2b is compatible with the variables conclave fills', () => {
  const vars = { TARGET_LABEL: 't', REVIEW_INPUT: 'i', REVIEW_SUMMARY: 's', USER_FOCUS: 'f', REVIEW_COLLECTION_GUIDANCE: 'g', PROJECT_CONTEXT: '' };
  assert.doesNotThrow(() => fillTemplate(realAssets.prompts.review, vars, { strict: true }));
});

test('review file names are anonymized after clustering raw paths', async () => {
  const reviews = Object.fromEntries(['A', 'B', 'C'].map((label) => [label, {
    verdict: 'needs-attention', summary: 'Check the guard.', next_steps: [],
    findings: [finding(`src/${label === 'C' ? 'qwen' : 'deepseek'}/calc.js`, 10, 12, 'Division by zero', 'high', 0.9)],
  }]));
  const h = harness((spec) => spec.role === 'judge'
    ? ok(synthesis(['A', 'B', 'C']), 'ses_judge')
    : ok(reviews[spec.label], `ses_${spec.label}`), { judge: { type: 'model', ...MEMBERS[2] } });
  const pkg = await h.run();
  // Both paths anonymize identically, but only the two identical raw paths cluster.
  assert.equal(pkg.review.clusters.length, 2);
  assert.deepEqual(pkg.review.clusters.map((c) => c.labels).sort(), [['A', 'B'], ['C']]);
  assert.ok(pkg.review.clusters.every((c) => c.file === 'src/[redacted]/calc.js'));
  const json = JSON.stringify(pkg);
  assert.doesNotMatch(json.slice(0, json.indexOf('"composition":')), /deepseek|qwen/i);
  assert.doesNotMatch(h.calls.find((c) => c.role === 'judge').prompt, /deepseek|qwen/i);
  assert.equal(pkg.final.responses[0].response.findings[0].file, 'src/[redacted]/calc.js');
  assert.equal(pkg.synthesisInput.review.clusters[0].file, 'src/[redacted]/calc.js');
  const markdown = renderConclave(pkg);
  assert.doesNotMatch(markdown.slice(0, markdown.indexOf('## Composição')), /deepseek|qwen/i);
  assert.equal(reviews.A.findings[0].file, 'src/deepseek/calc.js');
});
