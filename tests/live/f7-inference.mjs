// F7 live probes with inference (OPC_LIVE=1, OPC_LIVE_MODEL): compaction timing and pending revert + new prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { SKIP, MODELS, liveWorkspace, opc, fileLines, userText, appendSafeOutput } from './_f3-lib.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { readServerRecord } from '../../plugins/opc/scripts/lib/server.mjs';
import { REPO_ROOT } from '../helpers.mjs';

const REPORT = join(REPO_ROOT, 'docs/phases/F7-live-output.md');
const FIXTURE = join(REPO_ROOT, 'tests/fixtures/contract/opencode-2.0.22/compact.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fact = (key, value, dataDir) => appendSafeOutput(REPORT, `| \`${key}\` | \`${JSON.stringify(value).replaceAll('|', '\\|')}\` |\n`, dataDir);

test('F7 live: compaction timing and pending revert + new prompt', { skip: SKIP, timeout: 30 * 60_000 }, async (t) => {
  const { ws, env, dataDir, stateDir } = liveWorkspace(t);
  const notes = join(ws, 'notes.txt');
  const run = (args) => opc(args, { env, cwd: ws });
  appendSafeOutput(REPORT, '\n## f7-inference\n\n| Fato | Resultado |\n|---|---|\n', dataDir);

  let res = await run(['session', 'new', '--title', 'f7', '--model', MODELS.deepseek, '--write', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const sid = JSON.parse(res.stdout).session.id;
  for (const word of ['ALPHA', 'BETA']) {
    res = await run(['task', '--resume', sid, '--write', '--model', MODELS.deepseek, `Append a new line containing exactly ${word} to the end of notes.txt. Do not change anything else and do not run shell commands.`]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
  }
  const record = readServerRecord(stateDir());
  const api = createApi(createClient({ baseUrl: record.url, password: record.password, directory: ws }));

  // I2: stage a revert of the BETA turn, then send a new prompt and observe the revert and the files.
  const show = JSON.parse((await run(['session', 'show', sid, '--limit', '200', '--json'])).stdout);
  const beta = show.messages.filter((m) => m.type === 'user').find((m) => userText(m).includes('BETA')).id;
  res = await run(['session', 'revert', sid, beta, '--confirmed-by-user', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const afterStage = fileLines(notes);
  const revertBeforePrompt = (await api.getSession(sid)).revert ? 'pending' : 'none';
  res = await run(['task', '--resume', sid, '--model', MODELS.deepseek, 'Reply with exactly OK.']);
  const session = await api.getSession(sid);
  const ids = (await api.messages(sid)).map((m) => m.id);
  fact('I2-pending-revert', {
    afterStage, revertBeforePrompt, afterPrompt: fileLines(notes), promptExit: res.code,
    revertAfterPrompt: session.revert ? 'pending' : 'none', betaMessageKept: ids.includes(beta),
    verdict: session.revert ? 'keeps-pending' : ids.includes(beta) ? 'clears' : 'consolidates',
  }, dataDir);

  // I1: raw compaction (captured for the contract fixture) and the session state right after it.
  await api.setModel(sid, { providerID: MODELS.qwen.split('/')[0], id: MODELS.qwen.split('/').slice(1).join('/') });
  const startedAt = performance.now();
  const compaction = await api.compact(sid, { timeoutMs: 600_000 });
  const postMs = Math.round(performance.now() - startedAt);
  fs.writeFileSync(FIXTURE, `${JSON.stringify({ data: compaction }, null, 2)}\n`);
  const timeline = [];
  for (let i = 0; i < 480; i += 1) {
    const active = Boolean((await api.sessionStatus())?.[sid]);
    const current = await api.getSession(sid);
    timeline.push({ ms: Math.round(performance.now() - startedAt), active, compacting: current?.time?.compacting ?? null });
    if (!active && !current?.time?.compacting) break;
    await sleep(250);
  }
  const payload = async () => {
    const messages = await api.messages(sid);
    const marker = messages.find((m) => m.type === 'compaction');
    return { payloadKeys: marker ? Object.keys(marker.payload ?? {}).sort() : null, payloadBytes: marker ? JSON.stringify(marker.payload ?? null).length : null, messageTypes: messages.map((m) => m.type) };
  };
  const afterSettle = await payload();
  const busyAfterPost = Boolean(timeline[0]?.active || timeline[0]?.compacting);
  // One follow-up turn: tells whether the compaction message is only filled once the session runs again.
  res = await run(['task', '--resume', sid, '--model', MODELS.qwen, 'Reply with exactly OK.']);
  const afterTurn = await payload();
  const filled = (p) => (p.payloadBytes ?? 0) > 2;
  fact('I1-compaction', {
    postMs, firstPoll: timeline[0], settledMs: timeline.at(-1)?.ms, polls: timeline.length, followUpExit: res.code,
    afterSettle, afterTurn,
    verdict: busyAfterPost ? 'async' : filled(afterSettle) ? 'filled-on-post' : filled(afterTurn) ? 'filled-on-next-turn' : 'marker-only',
  }, dataDir);
});
