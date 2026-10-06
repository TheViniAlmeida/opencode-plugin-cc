import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validatePlan } from '../../plugins/opc/scripts/lib/orchestrator.mjs';
import { classifyTurn, makeOrchestrateScenario, turnLogPath } from '../fixtures/orchestrate-turns.mjs';
import { makeTempDir, readTurnLog, trackTempDir } from '../helpers.mjs';
import { PLAN as OK } from '../fixtures/scenarios/decompose-ok.mjs';
import { PLAN as CYCLE } from '../fixtures/scenarios/decompose-cycle.mjs';
import { PLAN as WRITES } from '../fixtures/scenarios/decompose-write-without-flag.mjs';
import { PLAN as FAIL } from '../fixtures/scenarios/subtask-fail.mjs';
import { PLAN as SYNTH } from '../fixtures/scenarios/synth-ok.mjs';

test('scenario plans have the validity each integration test relies on', () => {
  assert.equal(validatePlan(OK).ok, true);
  assert.equal(validatePlan(FAIL).ok, true);
  assert.equal(validatePlan(SYNTH).ok, true);
  assert.match(validatePlan(CYCLE).errors.join('\n'), /ciclo de dependência: a -> b -> a/);
  assert.match(validatePlan(WRITES, { write: false }).errors.join('\n'), /sem --write/);
  assert.equal(validatePlan(WRITES, { write: true }).ok, true);
});

test('classifyTurn recognises planner, synthesizer and subtask prompts', () => {
  assert.equal(classifyTurn({ text: '<orchestration_results>\n</orchestration_results>' }).role, 'synthesizer');
  assert.deepEqual(classifyTurn({ text: 'ctx\n<subtask id="w1">\ndo\n</subtask>' }).subtaskId, 'w1');
  assert.equal(classifyTurn({ text: '' }).role, 'other');
  assert.equal(classifyTurn({ text: 'You are the planner of a multi-model orchestration run by opc.\n<task>audit</task>' }).role, 'planner');
});

test('readTurnLog remains appended at the end of the shared helpers file', () => {
  const helpers = readFileSync(new URL('../helpers.mjs', import.meta.url), 'utf8');
  // Only later appended sections (`// ---- … (appended) ----` … `// ---- end … ----`) may follow the F4b block.
  assert.match(helpers, /\/\/ ---- F4b: orchestration helpers \(appended\) ----[\s\S]*?\/\/ ---- end F4b ----(\s*\/\/ ---- [^\n]* \(appended\) ----\n[\s\S]*?\/\/ ---- end [^\n]* ----)*\s*$/);
});

test('scenario logs each turn with its window and emits the planned result', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f4b-'));
  const previous = process.env.FAKE_OPENCODE_STATE;
  process.env.FAKE_OPENCODE_STATE = path.join(dir, 'state.json');
  t.after(() => { if (previous === undefined) delete process.env.FAKE_OPENCODE_STATE; else process.env.FAKE_OPENCODE_STATE = previous; });
  const emitted = [];
  const fake = { state: { sessions: Object.fromEntries(['ses_p', 'ses_text', 'ses_a', 'ses_b'].map((id, index) => [id, { model: { id: `m${index}` } }])) }, emitTurn: (sessionID, turn) => emitted.push([sessionID, turn]) };
  const scenario = makeOrchestrateScenario({ plan: OK, failSubtasks: ['b'], subtaskDelayMs: 30 });
  scenario.onPrompt(fake, 'ses_p', { text: 'You are the planner of a multi-model orchestration run by opc.' });
  scenario.onPrompt(fake, 'ses_text', { text: 'You are the planner of a multi-model orchestration run by opc.' });
  scenario.onPrompt(fake, 'ses_a', { text: '<subtask id="a">\nx\n</subtask>' });
  scenario.onPrompt(fake, 'ses_b', { text: '<subtask id="b">\nx\n</subtask>' });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(emitted.find(([s]) => s === 'ses_p')[1], { text: '\x60\x60\x60json\n' + JSON.stringify(OK) + '\n\x60\x60\x60' });
  assert.deepEqual(emitted.find(([s]) => s === 'ses_text')[1], { text: '\x60\x60\x60json\n' + JSON.stringify(OK) + '\n\x60\x60\x60' });
  assert.deepEqual(emitted.find(([s]) => s === 'ses_a')[1], { text: 'RESULT[a] by m2' });
  assert.equal(emitted.find(([s]) => s === 'ses_b')[1].error.type, 'provider.transport');
  const log = readFileSync(turnLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = log.find((e) => e.subtaskId === 'a');
  assert.equal(a.model, 'm2');
  assert.ok(a.end - a.start >= 25);
  assert.equal(statSync(turnLogPath()).mode & 0o777, 0o600);
});

test('turn window ends after asynchronous emitTurn completes', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f4b-'));
  const previous = process.env.FAKE_OPENCODE_STATE;
  process.env.FAKE_OPENCODE_STATE = path.join(dir, 'state.json');
  t.after(() => { if (previous === undefined) delete process.env.FAKE_OPENCODE_STATE; else process.env.FAKE_OPENCODE_STATE = previous; });
  let emittedAt;
  const fake = { state: { sessions: { ses_a: { model: { id: 'm1' } } } }, emitTurn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    emittedAt = Date.now();
  } };
  const scenario = makeOrchestrateScenario({ subtaskDelayMs: 5 });
  scenario.onPrompt(fake, 'ses_a', { text: '<subtask id="a">\nx\n</subtask>' });
  await new Promise((resolve) => setTimeout(resolve, 90));
  const [entry] = readTurnLog({ FAKE_OPENCODE_STATE: process.env.FAKE_OPENCODE_STATE });
  assert.ok(entry.end >= emittedAt, `logged end ${entry.end} precedes emitTurn completion ${emittedAt}`);
});

test('turn log never stores the prompt: only length, hash and result blocks this fake emitted itself', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f4b-'));
  const previous = process.env.FAKE_OPENCODE_STATE;
  process.env.FAKE_OPENCODE_STATE = path.join(dir, 'state.json');
  t.after(() => { if (previous === undefined) delete process.env.FAKE_OPENCODE_STATE; else process.env.FAKE_OPENCODE_STATE = previous; });
  const fake = { state: { sessions: { ses_a: { model: { id: 'm1' } }, ses_c: { model: { id: 'm3' } }, ses_s: { model: { id: 'm4' } } } }, emitTurn: async () => {} };
  const scenario = makeOrchestrateScenario({ subtaskDelayMs: 5 });
  scenario.onPrompt(fake, 'ses_a', { text: '<subtask id="a">\nx\n</subtask>' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const canary = 'USER-CANARY-NOT-A-REGISTERED-SECRET';
  // A block shaped exactly like the fake's reply but carrying user text (RESULT[b] by <canary>) must be dropped too.
  const subtask = `${canary}\n<dependency id="a">\nRESULT[a] by m1\n</dependency>\n<dependency id="b">\nRESULT[b] by ${canary}\n</dependency>\n<subtask id="c">\nx\n</subtask>`;
  scenario.onPrompt(fake, 'ses_c', { text: subtask });
  const synth = `<orchestration_results>\n<result id="a" kind="ask" status="completed">\nRESULT[a] by m1\n</result>\n<result id="b" kind="ask" status="failed">\nRESULT[b] by ${canary}\n</result>\n</orchestration_results>`;
  scenario.onPrompt(fake, 'ses_s', { text: synth });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const raw = readFileSync(turnLogPath(), 'utf8');
  assert.ok(!raw.includes(canary), 'no prompt text reaches the log');
  const log = readTurnLog({ FAKE_OPENCODE_STATE: process.env.FAKE_OPENCODE_STATE });
  const c = log.find((e) => e.role === 'subtask' && e.subtaskId === 'c');
  assert.equal('prompt' in c, false);
  assert.equal(c.promptLength, subtask.length);
  assert.match(c.promptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.dependencies, [{ id: 'a', result: 'RESULT[a] by m1' }], 'only fixture-shaped result blocks are kept');
  const s = log.find((e) => e.role === 'synthesizer');
  assert.deepEqual(s.results, [{ id: 'a', kind: 'ask', status: 'completed', result: 'RESULT[a] by m1' }]);
  assert.deepEqual(s.dependencies, []);
});
