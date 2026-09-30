// One test (or group) per F4c acceptance item of spec §13.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFakeState } from '../helpers.mjs';
import { loadConclaveAssets, buildSynthesisSchema, validateSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';
import {
  setupConclave, conclave, promptRequests, requestsBySchema, reviewRequests, sessionOfRequest, textOf, section,
  labelOf, writeReviewChanges, DS, QW, KM, TRIO, FORBIDDEN_NAMES,
} from './_conclave-helpers.mjs';
import { kindOf } from '../fixtures/scenarios/_conclave-common.mjs';

const Q = 'Should the storage layer add a write-ahead log?';
const FAST_TIMEOUT = { conclave: { memberTimeoutSec: 2 } };

// --- Composition validations -------------------------------------------------

test('composition: 1 member, invalid quorum, conflicting flags and bad rounds exit 2 without prompting', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const cases = [
    ['--models', DS, Q],
    ['--models', `${DS},${DS}`, Q],
    ['--models', `${DS},${QW}`, '--quorum', '1', Q],
    ['--models', `${DS},${QW}`, '--quorum', '3', Q],
    ['--models', `${DS},${QW}`, '--pool', 'default', Q],
    ['--models', `${DS},${QW}`, '--mode', 'debate', '--rounds', '1', Q],
    ['--models', `${DS},${QW}`, '--rounds', '4', Q],
    ['--models', `${DS},${QW}`, '--mode', 'vote', Q],
    ['--models', `${DS},${QW}`, '--mode', 'review', '--rounds', '2'],
    ['--models', `${DS},${QW}`, '--base', 'main', Q],
    ['--models', `${DS},${QW}`],
  ];
  for (const args of cases) {
    const res = await conclave(args, { env, cwd });
    assert.equal(res.code, 2, `${args.join(' ')} → exit ${res.code}\n${res.stdout}${res.stderr}`);
  }
  assert.equal(promptRequests(env).length, 0);
});

test('composition: pool from config; denied member skipped with a warning', async (t) => {
  const config = { conclave: { pools: { trio: [DS, QW, KM] }, defaultPool: 'trio' }, policy: { models: { allow: [], deny: ['*kimi*'] } } };
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion', config });
  const res = await conclave(['--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.json.composition.map((c) => c.model).sort(), [DS, QW].sort());
  assert.match(res.stderr, /ignorando "omniroute-personal\/opencode-go\/kimi-k3": modelo negado pela política/);
  assert.ok(requestsBySchema(env, 'ConclaveMember').every((r) => !r.body.model.modelID.includes('kimi')));
});

test('composition: every member denied → exit 4; denied judge → exit 4', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion', config: { policy: { models: { allow: [], deny: ['*kimi*', '*qwen*', '*deepseek*'] } } } });
  const allDenied = await conclave(['--models', TRIO, Q], { env, cwd });
  assert.equal(allDenied.code, 4, allDenied.stderr);
  const other = setupConclave(t, { scenario: 'conclave-opinion', config: { policy: { models: { allow: [], deny: ['*kimi*'] } } } });
  const judgeDenied = await conclave(['--models', `${DS},${QW}`, '--judge', KM, Q], other);
  assert.equal(judgeDenied.code, 4, judgeDenied.stderr);
  assert.equal(promptRequests(env).length + promptRequests(other.env).length, 0);
});

// --- Anonymization -----------------------------------------------------------

test('anonymization: no model, vendor or provider name reaches debate or judge prompts, even when members self-identify', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-self-identify' });
  const res = await conclave(['--models', `${DS},${QW}`, '--mode', 'debate', '--rounds', '2', '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const modelByLabel = new Map(pkg.composition.map(({ label, model }) => [label, model]));
  assert.ok([...modelByLabel.values()].some((model) => /deepseek/i.test(model)), 'composition maps labels to requested models');
  assert.equal(modelByLabel.size, 2);

  const debate = requestsBySchema(env, 'ConclaveDebate');
  const judge = requestsBySchema(env, 'ConclaveSynthesis');
  assert.equal(debate.length, 2);
  assert.equal(judge.length, 1);
  for (const r of [...debate, ...judge]) {
    const text = textOf(r.body).toLowerCase();
    for (const name of FORBIDDEN_NAMES) assert.ok(!text.includes(name), `"${name}" leaked into a ${kindOf(r.body)} prompt`);
  }
  for (const r of debate) assert.ok(section(textOf(r.body), 'peer_answers').includes('[redacted]'));
  assert.ok(section(textOf(judge[0].body), 'member_answers').includes('[redacted]'));
  const handedToClaude = JSON.stringify(pkg.synthesisInput).toLowerCase();
  for (const name of FORBIDDEN_NAMES) assert.ok(!handedToClaude.includes(name), `"${name}" leaked into synthesisInput`);
  assert.equal(pkg.judge.status, 'completed');
});

// --- Quorum ------------------------------------------------------------------

test('quorum met: text mode reports MissingStructuredOutput for a member without structured output', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-structured-error' });
  const res = await conclave(['--models', TRIO, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const qwen = labelOf(pkg, QW);
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [[qwen, 1, 'MissingStructuredOutput']]);
  assert.deepEqual(pkg.final.responses.map((r) => r.label).sort(), pkg.composition.filter((c) => c.label !== qwen).map((c) => c.label).sort());
  assert.ok(pkg.synthesisInput);
});

test('quorum met: tool mode discards and lists a StructuredOutputError member; the rest synthesize', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-structured-error', config: { conclave: { structuredOutput: 'tool' } } });
  const res = await conclave(['--models', TRIO, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const qwen = labelOf(pkg, QW);
  assert.equal(pkg.status, 'completed');
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [[qwen, 1, 'StructuredOutputError']]);
  assert.ok(requestsBySchema(env, 'ConclaveMember').every((r) => r.body.format?.type === 'json_schema'));
  assert.ok(requestsBySchema(env, 'ConclaveSynthesis').every((r) => r.body.format?.type === 'json_schema'));
  assert.ok(pkg.synthesisInput);
});

test('member timeout: the silent member is aborted, discarded and left out of the debate', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-timeout', config: FAST_TIMEOUT });
  const res = await conclave(['--models', TRIO, '--mode', 'debate', '--json', Q], { env, cwd, timeoutMs: 120_000 });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const kimi = labelOf(pkg, KM);
  assert.deepEqual(pkg.failures.map((f) => [f.label, f.round, f.errorType]), [[kimi, 1, 'Timeout']]);
  const debate = requestsBySchema(env, 'ConclaveDebate');
  assert.equal(debate.length, 2);
  for (const r of debate) assert.ok(!textOf(r.body).includes(`<peer label="${kimi}">`));
  const kimiSession = sessionOfRequest(requestsBySchema(env, 'ConclaveMember').find((r) => r.body.model.modelID.includes('kimi')));
  assert.ok(readFakeState(env).requests.some((r) => r.method === 'POST' && r.path === `/session/${kimiSession}/abort`));
  assert.equal(pkg.rounds.completed, 2);
});

test('quorum not met: exit 7, group failed, partial answers kept and no judge', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-member-timeout', config: FAST_TIMEOUT });
  const res = await conclave(['--models', TRIO, '--quorum', '3', '--judge', `${DS}`, '--allow-judge-member', '--json', Q], { env, cwd, timeoutMs: 120_000 });
  assert.equal(res.code, 7, res.stderr);
  const pkg = res.json;
  assert.equal(pkg.status, 'failed');
  assert.deepEqual(pkg.failure, { code: 'QUORUM_NOT_MET', round: 1, valid: 2, quorum: 3 });
  assert.equal(pkg.final.responses.length, 2);
  assert.equal(pkg.judge.status, 'skipped');
  assert.equal(pkg.synthesisInput, null);
  assert.equal(requestsBySchema(env, 'ConclaveSynthesis').length, 0);
});

// --- Debate ------------------------------------------------------------------

test('debate: round 2 runs in each member own session and records changed per member', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-debate' });
  const res = await conclave(['--models', TRIO, '--mode', 'debate', '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.deepEqual(pkg.rounds, { requested: 2, completed: 2 });
  const round1 = requestsBySchema(env, 'ConclaveMember');
  const round2 = requestsBySchema(env, 'ConclaveDebate');
  assert.equal(round2.length, 3);
  for (const r of round2) {
    const own = round1.find((m) => m.body.model.modelID === r.body.model.modelID);
    assert.equal(sessionOfRequest(r), sessionOfRequest(own));
  }
  const round2Answers = pkg.roundsData[1].responses;
  assert.ok(round2Answers.every((a) => typeof a.response.changed === 'boolean'));
  assert.equal(round2Answers.find((a) => a.label === labelOf(pkg, DS)).response.changed, true);
  assert.deepEqual(round2Answers.filter((a) => a.response.changed).length, 1);
  for (const a of round2Answers) assert.ok(a.response.critiques.every((c) => c.target !== a.label));
});

// --- Review mode -------------------------------------------------------------

test('review: overlapping findings dedupe into clusters with k/N agreement; findings without file stay alone; verdict', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-review' });
  writeReviewChanges(cwd);
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  const reviews = reviewRequests(env);
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every((r) => textOf(r.body).includes('src/calc.js')), 'the collected diff is in every review prompt');

  const { clusters, verdict, reasons, validMembers } = pkg.review;
  assert.equal(validMembers, 3);
  assert.equal(clusters.length, 6);
  assert.ok(clusters.every((c) => c.agreement.n === 3 && c.agreement.text === `${c.agreement.k}/3`));

  const merged = clusters.find((c) => c.agreement.k === 2);
  assert.equal(merged.file, 'src/calc.js');
  assert.deepEqual([merged.line_start, merged.line_end, merged.severity, merged.meanConfidence], [10, 14, 'critical', 0.8]);
  assert.deepEqual(merged.labels, [labelOf(pkg, DS), labelOf(pkg, QW)].sort());
  assert.equal(merged.bestLabel, labelOf(pkg, DS));
  assert.equal(clusters.filter((c) => c.agreement.k === 2).length, 1);

  const farCalc = clusters.filter((c) => c.file === 'src/calc.js' && c.agreement.k === 1);
  assert.deepEqual(farCalc.map((c) => [c.line_start, c.labels]), [[30, [labelOf(pkg, KM)]]]);
  assert.equal(clusters.filter((c) => c.file === 'src/list.js').length, 2);

  const noFile = clusters.filter((c) => c.file === null);
  assert.equal(noFile.length, 2, 'findings without file are never clustered');
  assert.ok(noFile.every((c) => c.agreement.text === '1/3'));

  assert.equal(verdict, 'needs-attention');
  assert.deepEqual(reasons.map((r) => r.code), ['SEVERE_FINDING_AGREED', 'MAJORITY_NEEDS_ATTENTION']);
});

test('review: members without findings approve and produce no clusters', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  writeReviewChanges(cwd);
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.review.validMembers, 3);
  assert.equal(res.json.review.verdict, 'approve');
  assert.deepEqual(res.json.review.clusters, []);
});

test('review: outside a git repository the command fails with a usage error before any session', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok', git: false });
  const res = await conclave(['--models', TRIO, '--mode', 'review', '--json'], { env, cwd });
  assert.equal(res.code, 2);
  assert.equal(promptRequests(env).length, 0);
});

// --- Judge -------------------------------------------------------------------

test('judge model: read-only session sees only labels; synthesis validated against conclave-synthesis', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  const res = await conclave(['--models', `${DS},${QW}`, '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  const pkg = res.json;
  assert.equal(pkg.judge.type, 'model');
  assert.equal(pkg.judge.model, KM);
  assert.equal(pkg.judge.status, 'completed');
  const schema = buildSynthesisSchema(loadConclaveAssets().schemas.synthesis, ['A', 'B']);
  assert.deepEqual(validateSchema(pkg.judge.synthesis, schema), []);
  const [judgeReq] = requestsBySchema(env, 'ConclaveSynthesis');
  assert.match(textOf(judgeReq.body), /<labels>A, B<\/labels>/);
  const judgeSession = readFakeState(env).requests.filter((r) => r.method === 'POST' && r.path === '/session').find((s) => s.body.title === 'OPC: conclave: judge');
  assert.deepEqual(judgeSession.body.permission[0], { permission: '*', pattern: '*', action: 'deny' });
});

test('judge failure in text mode keeps the conclave completed with MissingStructuredOutput warning', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion' });
  const res = await conclave(['--models', `${DS},${QW}`, '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.judge.status, 'failed');
  assert.equal(res.json.judge.error.errorType, 'MissingStructuredOutput');
  assert.ok(res.json.warnings.some((w) => /opc-conclave/.test(w)));
});

test('judge StructuredOutputError in tool mode keeps the conclave completed with a warning', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'conclave-opinion', config: { conclave: { structuredOutput: 'tool' } } });
  const res = await conclave(['--models', `${DS},${QW}`, '--judge', KM, '--json', Q], { env, cwd });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.judge.status, 'failed');
  assert.equal(res.json.judge.error.errorType, 'StructuredOutputError');
  assert.ok(res.json.warnings.some((w) => /opc-conclave/.test(w)));
  assert.ok(requestsBySchema(env, 'ConclaveSynthesis').every((r) => r.body.format?.type === 'json_schema'));
});

test('--allow-judge-member: required when the judge is also a member', async (t) => {
  const { env, cwd } = setupConclave(t, { scenario: 'judge-ok' });
  const refused = await conclave(['--models', `${DS},${QW}`, '--judge', DS, '--json', Q], { env, cwd });
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(`${refused.stdout}${refused.stderr}`, /--allow-judge-member/);
  const allowed = await conclave(['--models', `${DS},${QW}`, '--judge', DS, '--allow-judge-member', '--json', Q], { env, cwd });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.json.judge.model, DS);
  assert.equal(allowed.json.judge.status, 'completed');
});
