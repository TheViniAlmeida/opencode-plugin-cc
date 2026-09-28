import test from 'node:test';
import assert from 'node:assert/strict';

import { LIVE_SKIP, liveCli, livePrepare, plantBug } from './_f2b-live-helpers.mjs';

function classify(result) {
  const payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  if (payload?.decision === 'block') return { verdict: 'BLOCK', detail: payload.reason };
  if (payload?.systemMessage?.includes('resposta inesperada')) return { verdict: 'MALFORMED', detail: payload.systemMessage };
  if (payload?.systemMessage) return { verdict: 'INFRA', detail: payload.systemMessage };
  return { verdict: 'ALLOW', detail: null };
}

test('live F2b: stop gate blocks a planted error (3 runs, at least 2 BLOCK)', { skip: LIVE_SKIP, timeout: 50 * 60 * 1000 }, async (t) => {
  const ctx = livePrepare(t, { config: { stopGate: { enabled: true, model: null } } });
  plantBug(ctx.cwd);
  const stdin = JSON.stringify({
    session_id: 'live-gate',
    cwd: ctx.cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    transcript_path: '',
    last_assistant_message: 'Adicionei average() e divide() a src/math.js e alterei o loop de sum(). A mudança está concluída.',
  });
  const verdicts = [];
  for (let run = 1; run <= 3; run += 1) {
    const result = await liveCli(ctx, ['hook-stop'], { stdin, timeoutMs: 16 * 60 * 1000 });
    assert.equal(result.code, 0, result.stderr);
    const { verdict, detail } = classify(result);
    verdicts.push({ run, verdict, detail });
    t.diagnostic(`gate run ${run}: ${verdict}${detail ? ` — ${detail}` : ''}`);
  }
  assert.equal(verdicts.filter((entry) => entry.verdict === 'INFRA').length, 0, JSON.stringify(verdicts, null, 2));
  assert.ok(verdicts.filter((entry) => entry.verdict === 'BLOCK').length >= 2, JSON.stringify(verdicts, null, 2));
});

test('live F2b: stop_hook_active allows without running the gate', { skip: LIVE_SKIP, timeout: 120000 }, async (t) => {
  const ctx = livePrepare(t, { config: { stopGate: { enabled: true, model: null } } });
  plantBug(ctx.cwd);
  const stdin = JSON.stringify({ session_id: 'live-gate', cwd: ctx.cwd, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'x' });
  const result = await liveCli(ctx, ['hook-stop'], { stdin, timeoutMs: 60000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});
