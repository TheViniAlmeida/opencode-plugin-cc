// F4b live gate: real planner + subtasks routed across models. Only with OPC_LIVE=1.
// Routes come from the environment (OPC_LIVE_MODEL, _2, _3; planner: OPC_LIVE_PLANNER_MODEL or _3),
// because the plan's opencode-go/* routes answer 402 (fatal) on the gateway used by the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, makeWorkspace, runCli, trackEnv, trackTempDir, writeGlobalConfig, REPO_ROOT } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';
import { FAST, SECOND, THIRD, DEFAULT_PROVIDER, SKIP, cleanupLive } from './_f4a-lib.mjs';
import { SUBTASK_KINDS } from '../../plugins/opc/scripts/lib/orchestrator.mjs';

const REPORT = path.join(REPO_ROOT, 'docs/phases/F4b-live-output.md');
const PLANNER = process.env.OPC_LIVE_PLANNER_MODEL?.trim() || THIRD;
const SYNTH = THIRD;
const TIMEOUT_MS = 40 * 60 * 1000;
const TASK = [
  'Analyze this small JavaScript repository using at least 3 independent subtasks:',
  '(1) list every function exported by src/math.mjs and src/text.mjs with a one-line description;',
  '(2) review src/math.mjs for bugs and edge cases, citing file:line;',
  '(3) propose a unit test plan covering both files.',
  'Do not modify any file.',
].join(' ');

const LIVE_CONFIG = {
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: FAST,
  aliases: { fast: FAST, second: SECOND, third: THIRD, planner: PLANNER },
  orchestrate: { planner: 'planner', maxSubtasks: 5, synthesizer: 'claude' },
  routing: {
    tasks: { ask: ['fast', 'second', 'third'], plan: ['third', 'second', 'fast'], review: ['second', 'third', 'fast'], task: ['fast', 'second'] },
    tiers: { light: ['fast', 'second'], heavy: ['third', 'second'] },
    fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 },
  },
  jobs: { maxActive: 8, maxParallel: 4 },
};

const FILES = {
  'src/math.mjs': [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function divide(a, b) {',
    '  return a / b;',
    '}',
    '',
    'export function average(values) {',
    '  return values.reduce((sum, v) => sum + v, 0) / values.length;',
    '}',
    '',
  ].join('\n'),
  'src/text.mjs': [
    'export function slugify(text) {',
    "  return text.toLowerCase().replace(/\\s+/g, '-');",
    '}',
    '',
    'export function truncate(text, max) {',
    "  return text.length > max ? `${text.slice(0, max)}...` : text;",
    '}',
    '',
  ].join('\n'),
};

function liveSetup(t) {
  const ws = makeWorkspace(t, { name: 'f4b-live' });
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }
  execFileSync('git', ['add', '.'], { cwd: ws });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: ws });
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f4b-'));
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  delete env.OPC_SERVER_PASSWORD;
  writeGlobalConfig(env, LIVE_CONFIG);
  return { ws, env, dataDir };
}

function checksum(ws) {
  const hash = createHash('sha256');
  for (const rel of Object.keys(FILES).sort()) hash.update(readFileSync(path.join(ws, rel)));
  return hash.digest('hex');
}

function assertPackage(pkg) {
  assert.equal(pkg.schemaVersion, 1);
  assert.equal(pkg.status, 'completed', `group status: ${pkg.errorCode} ${pkg.errorMessage}`);
  assert.equal(typeof pkg.plan.rationale, 'string');
  assert.ok(pkg.plan.rationale.trim().length > 0, 'rationale present');
  assert.ok(pkg.plan.subtasks.length >= 2 && pkg.plan.subtasks.length <= 5, `plan size ${pkg.plan.subtasks.length}`);
  const ids = new Set();
  for (const s of pkg.subtasks) {
    assert.ok(typeof s.id === 'string' && !ids.has(s.id), `unique id ${s.id}`);
    ids.add(s.id);
    assert.ok(SUBTASK_KINDS.includes(s.kind) && s.kind !== 'task', `read-only kind ${s.kind}`);
    assert.ok(Array.isArray(s.dependsOn));
    if (s.status === 'completed') {
      assert.ok(typeof s.model === 'string' && s.model.startsWith(`${DEFAULT_PROVIDER}/`), `model of ${s.id}`);
      assert.ok(s.result.trim().length > 0, `result of ${s.id}`);
    }
  }
  const completed = pkg.subtasks.filter((s) => s.status === 'completed');
  assert.ok(completed.length >= 2, `completed subtasks: ${completed.length}`);
  const models = new Set(completed.map((s) => s.model));
  assert.ok(models.size >= 2, `distinct models: ${[...models].join(', ')}`);
}

function summary(label, out, dataDir) {
  const pkg = out.orchestration;
  const rows = (pkg?.subtasks ?? []).map((s) => `  - ${s.id} (${s.kind}) ${s.model ?? '-'} ${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}`);
  const line = `[f4b-live] ${label}: job=${out.jobId} outcome=${pkg?.outcome} planner=${pkg?.planner?.model} subtasks=${pkg?.subtasks?.length} synthesis=${pkg?.synthesis?.mode}/${pkg?.synthesis?.status} duration=${((pkg?.durationMs ?? 0) / 1000).toFixed(1)}s\n${rows.join('\n')}`;
  console.log(safeOutputText(line, dataDir));
  appendSafeOutput(REPORT, `### ${label}\n\n\`\`\`\n${safeOutputText(line, dataDir)}\n\`\`\`\n\n`, dataDir);
}

test('F4b live: real task, valid plan, subtasks on different models, Claude synthesis package', { skip: SKIP, timeout: TIMEOUT_MS }, async (t) => {
  const { ws, env, dataDir } = liveSetup(t);
  try {
    const before = checksum(ws);
    const res = await runCli(['orchestrate', '--json', TASK], { env, cwd: ws, timeoutMs: TIMEOUT_MS - 60000 });
    const out = JSON.parse(res.stdout || '{}');
    summary('claude-synthesis', out, dataDir);
    assert.equal(res.code, 0, safeOutputText(res.stderr, dataDir));
    assertPackage(out.orchestration);
    assert.equal(out.orchestration.planner.model, PLANNER);
    assert.deepEqual([out.orchestration.synthesis.mode, out.orchestration.synthesis.status], ['claude', 'pending']);
    assert.equal(checksum(ws), before, 'read-only orchestration left the files unchanged');
  } finally { await cleanupLive(env, ws); }
});

test('F4b live: synthesis by model', { skip: SKIP, timeout: TIMEOUT_MS }, async (t) => {
  const { ws, env, dataDir } = liveSetup(t);
  try {
    const res = await runCli(['orchestrate', '--json', '--synthesizer', SYNTH, TASK], { env, cwd: ws, timeoutMs: TIMEOUT_MS - 60000 });
    const out = JSON.parse(res.stdout || '{}');
    summary('model-synthesis', out, dataDir);
    assert.equal(res.code, 0, safeOutputText(res.stderr, dataDir));
    assertPackage(out.orchestration);
    const synthesis = out.orchestration.synthesis;
    assert.deepEqual([synthesis.mode, synthesis.status, synthesis.model], ['model', 'completed', SYNTH], synthesis.errorMessage ?? '');
    assert.ok(synthesis.text.trim().length > 40, 'non-trivial synthesis text');
  } finally { await cleanupLive(env, ws); }
});
