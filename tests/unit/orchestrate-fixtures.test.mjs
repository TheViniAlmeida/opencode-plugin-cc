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
  assert.equal(classifyTurn({ format: { type: 'json_schema' }, parts: [{ type: 'text', text: 'x' }] }).role, 'planner');
  assert.equal(classifyTurn({ parts: [{ type: 'text', text: '<orchestration_results>\n</orchestration_results>' }] }).role, 'synthesizer');
  assert.deepEqual(classifyTurn({ parts: [{ type: 'text', text: 'ctx\n<subtask id="w1">\ndo\n</subtask>' }] }).subtaskId, 'w1');
  assert.equal(classifyTurn({ parts: [] }).role, 'other');
  assert.equal(classifyTurn({ parts: [{ type: 'text', text: 'You are the planner of a multi-model orchestration run by opc.\n<task>audit</task>' }] }).role, 'planner');
});

test('readTurnLog remains appended at the end of the shared helpers file', () => {
  const helpers = readFileSync(new URL('../helpers.mjs', import.meta.url), 'utf8');
  assert.match(helpers, /\/\/ ---- F4b: orchestration helpers \(appended\) ----[\s\S]*\/\/ ---- end F4b ----\s*$/);
});

test('scenario logs each turn with its window and emits the planned result', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f4b-'));
  const previous = process.env.FAKE_OPENCODE_STATE;
  process.env.FAKE_OPENCODE_STATE = path.join(dir, 'state.json');
  t.after(() => { if (previous === undefined) delete process.env.FAKE_OPENCODE_STATE; else process.env.FAKE_OPENCODE_STATE = previous; });
  const emitted = [];
  const fake = { emitTurn: (sessionID, turn) => emitted.push([sessionID, turn]) };
  const scenario = makeOrchestrateScenario({ plan: OK, failSubtasks: ['b'], subtaskDelayMs: 30 });
  scenario.onPromptAsync(fake, 'ses_p', { model: { modelID: 'm0' }, format: { type: 'json_schema' }, parts: [{ type: 'text', text: 'plan it' }] });
  scenario.onPromptAsync(fake, 'ses_text', { model: { modelID: 'm0' }, parts: [{ type: 'text', text: 'You are the planner of a multi-model orchestration run by opc.' }] });
  scenario.onPromptAsync(fake, 'ses_a', { model: { modelID: 'm1' }, parts: [{ type: 'text', text: '<subtask id="a">\nx\n</subtask>' }] });
  scenario.onPromptAsync(fake, 'ses_b', { model: { modelID: 'm2' }, parts: [{ type: 'text', text: '<subtask id="b">\nx\n</subtask>' }] });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(emitted.find(([s]) => s === 'ses_p')[1], { text: '', structured: OK });
  assert.deepEqual(emitted.find(([s]) => s === 'ses_text')[1], { text: '\x60\x60\x60json\n' + JSON.stringify(OK) + '\n\x60\x60\x60' });
  assert.deepEqual(emitted.find(([s]) => s === 'ses_a')[1], { text: 'RESULT[a] by m1' });
  assert.equal(emitted.find(([s]) => s === 'ses_b')[1].error.name, 'UnknownError');
  const log = readFileSync(turnLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = log.find((e) => e.subtaskId === 'a');
  assert.equal(a.model, 'm1');
  assert.ok(a.end - a.start >= 25);
  assert.equal(statSync(turnLogPath()).mode & 0o777, 0o600);
});

test('turn window ends after asynchronous emitTurn completes', async (t) => {
  const dir = trackTempDir(t, makeTempDir('opc-f4b-'));
  const previous = process.env.FAKE_OPENCODE_STATE;
  process.env.FAKE_OPENCODE_STATE = path.join(dir, 'state.json');
  t.after(() => { if (previous === undefined) delete process.env.FAKE_OPENCODE_STATE; else process.env.FAKE_OPENCODE_STATE = previous; });
  let emittedAt;
  const fake = { emitTurn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    emittedAt = Date.now();
  } };
  const scenario = makeOrchestrateScenario({ subtaskDelayMs: 5 });
  scenario.onPromptAsync(fake, 'ses_a', { model: { modelID: 'm1' }, parts: [{ type: 'text', text: '<subtask id="a">\nx\n</subtask>' }] });
  await new Promise((resolve) => setTimeout(resolve, 90));
  const [entry] = readTurnLog({ FAKE_OPENCODE_STATE: process.env.FAKE_OPENCODE_STATE });
  assert.ok(entry.end >= emittedAt, `logged end ${entry.end} precedes emitTurn completion ${emittedAt}`);
});
