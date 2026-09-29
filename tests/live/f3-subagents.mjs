import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, MODELS, liveWorkspace, opc, record, note, assertModelRouting, assertIntervalsOverlap } from './_f3-lib.mjs';
const PROMPT = 'Reply with one short sentence that contains the word PINEAPPLE. Do not use any tool.';

test('F3 live: three parallel subagents, one per model', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const res = await opc(['subagent', '--agent', 'general', '--model', `${MODELS.deepseek},${MODELS.qwen},${MODELS.kimi}`, '--json', PROMPT], { env, cwd: ws });
  record('subagent x3', res, dataDir);
  assert.equal(res.code, 0, res.stderr);
  const { group, members } = JSON.parse(res.stdout);
  assert.equal(group.status, 'completed'); assert.equal(members.length, 3);
  const routeSummary = assertModelRouting(members, [MODELS.deepseek, MODELS.qwen, MODELS.kimi]);
  note('modelos configurados para o subagent x3', { routeSummary, configuredModels: [MODELS.deepseek, MODELS.qwen, MODELS.kimi] }, dataDir);
  assert.equal(new Set(members.map((m) => m.sessionID)).size, 3);
  const maxParallel = assertIntervalsOverlap(members);
  for (const m of members) {
    assert.equal(m.status, 'completed', `${m.model}: ${m.errorMessage}`);
    assert.match(m.result.finalText, /pineapple/i, m.model);
    const shown = JSON.parse((await opc(['session', 'show', m.result.carrierSessionID ?? m.sessionID, '--json'], { env, cwd: ws })).stdout);
    assert.equal(shown.session.parentID, group.sessionID);
  }
  note('roteamento e concorrência por membro (§15 itens 7 e 11)', { routeSummary, maxParallel, members: members.map((m) => ({ model: m.model, mechanism: m.result.mechanism, fellBack: m.result.fellBack, startedAt: m.startedAt, completedAt: m.completedAt })) }, dataDir);
});

test('F3 live: grupo em segundo plano, status --wait e resultado', { skip: SKIP, timeout: 40 * 60_000 }, async (t) => {
  const { ws, env, dataDir } = liveWorkspace(t);
  const bg = await opc(['subagent', '--agent', 'general', '--model', `${MODELS.deepseek},${MODELS.kimi}`, '--background', '--json', PROMPT], { env, cwd: ws });
  record('subagent --background', bg, dataDir);
  assert.equal(bg.code, 0, bg.stderr);
  const { group } = JSON.parse(bg.stdout);
  const waited = await opc(['status', group.id, '--wait', '--timeout-ms', '1800000', '--json'], { env, cwd: ws });
  record('status --wait (grupo)', waited, dataDir);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).group.status, 'completed');
  const result = await opc(['result', group.id], { env, cwd: ws });
  record('result (grupo)', result, dataDir);
  assert.equal(result.code, 0);
  assert.equal((result.stdout.match(/^## #/gm) ?? []).length, 2);
});
