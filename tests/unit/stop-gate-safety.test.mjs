import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { parseStopGateOutput, run as runStopHook } from '../../plugins/opc/scripts/commands/hook-stop.mjs';
import { makeTempDir, trackTempDir } from '../helpers.mjs';
import { registerSecret } from '../../plugins/opc/scripts/lib/redact.mjs';

async function hookContext(t) {
  const cwd = trackTempDir(t, makeTempDir('opc-stop-hook-'));
  const stateDir = path.join(cwd, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const output = { stdout: '', stderr: '' };
  const ctx = {
    cwd,
    workspaceRoot: cwd,
    stateDir,
    dataDir: cwd,
    env: {},
    config: { stopGate: { enabled: true, model: null }, project: null, policy: { sensitivePaths: [] } },
    stdin: Readable.from([JSON.stringify({ cwd, session_id: 'test-session', stop_hook_active: false })]),
    out: (text) => { output.stdout += text; },
    err: (text) => { output.stderr += text; },
  };
  return { ctx, output };
}

test('Stop hook masks model-produced secrets in a block reason', async (t) => {
  const { ctx, output } = await hookContext(t);
  const leaked = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx'].join('-');
  const result = await runStopHook(ctx, {
    runStopGateFn: async () => parseStopGateOutput(`BLOCK: leaked ${leaked} value`),
  });
  assert.equal(result, 0);
  const payload = JSON.parse(output.stdout);
  assert.match(payload.reason, /\*\*\*/);
  assert.doesNotMatch(payload.reason, /sk-proj-/);
});

test('Stop hook caps the masked block reason at 2000 characters', async (t) => {
  const { ctx, output } = await hookContext(t);
  await runStopHook(ctx, {
    runStopGateFn: async () => parseStopGateOutput(`BLOCK: ${'x'.repeat(2200)}`),
  });
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.reason.slice('opc stop gate: '.length).length, 2000);
});

test('Stop hook reports a failed cancellation in systemMessage and stderr, while allowing', async (t) => {
  for (const cleanup of ['wait-rejected', 'still-active']) {
    const { ctx, output } = await hookContext(t);
    const result = await runStopHook(ctx, {
      connectApiFn: async () => ({ api: {} }),
      resolveTurnModelFn: async () => ({ model: 'model', full: 'provider/model', variant: null, resolution: { candidates: [], fallbackEligible: false } }),
      turnJobRequestFn: () => ({ title: 'gate request' }),
      submitTurnJobFn: async () => ({ id: 'gate-job-1' }),
      waitForJobFn: async () => {
        if (cleanup === 'wait-rejected') throw new Error('wait timed out');
        return { id: 'gate-job-1', status: 'running' };
      },
      cancelJobFn: async () => ({ ok: false, code: 'CANCEL_FAILED' }),
    });
    assert.equal(result, 0);
    const payload = JSON.parse(output.stdout);
    for (const text of [payload.systemMessage, output.stderr]) {
      assert.match(text, /gate-job-1/);
      assert.match(text, /CANCEL_FAILED/);
      assert.match(text, /ainda pode estar em execução/);
      assert.match(text, /\/opc:cancel gate-job-1/);
    }
  }
});

test('Stop wait uses entry deadline minus slow setup and cancellation reserve', async (t) => {
  const { ctx } = await hookContext(t);
  let clock = 0;
  let budget;
  await runStopHook(ctx, {
    now: () => clock,
    connectApiFn: async () => { clock += 120_000; return { api: {} }; },
    resolveTurnModelFn: async () => { clock += 40_000; return { model: 'm', full: 'p/m', resolution: { candidates: [], fallbackEligible: false } }; },
    turnJobRequestFn: () => ({ title: 'gate' }),
    submitTurnJobFn: async () => { clock += 10_000; return { id: 'gate-1' }; },
    waitForJobFn: async (_ctx, _id, options) => { budget = options.waitTimeoutMs; return { status: 'completed', result: { finalText: 'ALLOW: certo' } }; },
  });
  assert.equal(budget, 900_000 - 170_000 - 60_000);
});


test('Stop cancels and allows when setup consumes the entire wait budget', async (t) => {
  const { ctx, output } = await hookContext(t);
  let clock = 0, cancelled = false;
  ctx.hookEnteredAt = 0;
  await runStopHook(ctx, {
    now: () => clock,
    connectApiFn: async () => ({ api: {} }),
    resolveTurnModelFn: async () => ({ model: 'm', full: 'p/m', resolution: { candidates: [], fallbackEligible: false } }),
    turnJobRequestFn: () => ({ title: 'gate' }),
    submitTurnJobFn: async () => { clock = 850_000; return { id: 'gate-exhausted' }; },
    waitForJobFn: async () => { assert.fail('no wait remains'); },
    cancelJobFn: async () => { cancelled = true; return { ok: true }; },
  });
  assert.ok(cancelled);
  assert.match(JSON.parse(output.stdout).systemMessage, /permitiu o encerramento/);
});


test('Stop systemMessage masks model-derived reasons before interpolation', async (t) => {
  const { ctx, output } = await hookContext(t);
  const value = ['ghp', 'z'.repeat(32)].join('_');
  await runStopHook(ctx, { runStopGateFn: async () => ({ kind: 'malformed', reason: value }) });
  const payload = JSON.parse(output.stdout);
  assert.ok(!payload.systemMessage.includes(value));
  assert.match(payload.systemMessage, /\*\*\*/);
});

for (const source of ['job', 'turn', 'exception', 'error-code']) {
  test(`Stop failure includes a bounded masked ${source} cause on both outputs`, async (t) => {
    const { ctx, output } = await hookContext(t);
    const token = ['ghp', 'z'.repeat(32)].join('_');
    const registered = ['private', 'diagnostic', 'value'].join('-');
    registerSecret(registered);
    const message = `[402] token=${token} ${registered} saldo insuficiente ` + 'x'.repeat(300);
    const failure = { errorName: 'APIError', errorMessage: message };
    await runStopHook(ctx, {
      connectApiFn: async () => {
        if (source === 'exception') throw Object.assign(new Error(message), { name: 'APIError' });
        return { api: {} };
      },
      resolveTurnModelFn: async () => ({ model: { providerID: 'p', modelID: 'm' }, full: 'p/m', resolution: { candidates: [], fallbackEligible: false } }),
      submitTurnJobFn: async () => ({ id: 'gate-error' }),
      waitForJobFn: async () => ({ id: 'gate-error', status: 'failed', ...(source === 'error-code' ? { errorCode: 'APIError', errorMessage: message } : source === 'job' ? failure : { result: failure }) }),
    });
    const payload = JSON.parse(output.stdout);
    assert.equal(payload.decision, undefined);
    const cause = payload.systemMessage.match(/STOP_GATE_FAILED \((.*?)\)/)?.[1];
    assert.ok(cause, payload.systemMessage);
    assert.match(cause, /^APIError: \[402\]/);
    assert.ok(cause.length <= 200);
    assert.ok(output.stderr.includes(cause));
    assert.ok(!(output.stdout + output.stderr).includes(token));
    assert.ok(!(output.stdout + output.stderr).includes(registered));
    assert.match(cause, /\*\*\*/);
  });
}

for (const mode of ['text', 'tool']) {
  test(`Stop request never sends format with review mode ${mode}`, async (t) => {
    const { ctx, output } = await hookContext(t);
    ctx.config.review = { structuredOutput: mode };
    await runStopHook(ctx, {
      connectApiFn: async () => ({ api: {} }),
      resolveTurnModelFn: async () => ({ model: { providerID: 'p', modelID: 'm' }, full: 'p/m', resolution: { candidates: [], fallbackEligible: false } }),
      submitTurnJobFn: async (_ctx, { request }) => { assert.equal(request.format, null); return { id: 'gate-text' }; },
      waitForJobFn: async () => ({ status: 'completed', result: { finalText: 'ALLOW: Tudo certo.' } }),
    });
    assert.equal(output.stdout, '');
  });
}

test('Stop context failure also exposes the short cause and allows', async (t) => {
  const { ctx, output } = await hookContext(t);
  Object.defineProperty(ctx, 'workspaceRoot', { get() { throw Object.assign(new Error('Contexto indisponível.'), { code: 'CONTEXT_FAILED' }); } });
  assert.equal(await runStopHook(ctx), 0);
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.decision, undefined);
  for (const text of [payload.systemMessage, output.stderr]) assert.match(text, /STOP_GATE_FAILED \(CONTEXT_FAILED: Contexto indisponível\.\)/);
});

test('F4a I2: stop-gate request preserves route candidates and fallback eligibility', async (t) => {
  const { ctx, output } = await hookContext(t);
  ctx.config.routing = { tasks: { 'stop-gate': ['p/first', 'p/second'] } };
  let submitted;
  await runStopHook(ctx, {
    connectApiFn: async () => ({ api: {
      providers: async () => ({ connected: ['p'], all: [{ id: 'p', models: { first: { id: 'first' }, second: { id: 'second' } } }] }),
      getConfig: async () => ({}),
    } }),
    submitTurnJobFn: async (_ctx, { request }) => { submitted = request; return { id: 'gate-routed' }; },
    waitForJobFn: async () => ({ status: 'completed', result: { finalText: 'ALLOW: certo' } }),
  });
  assert.equal(output.stdout, '');
  assert.equal(submitted.fallbackEligible, true);
  assert.deepEqual(submitted.candidates.map((c) => c.full), ['p/first', 'p/second']);
});
