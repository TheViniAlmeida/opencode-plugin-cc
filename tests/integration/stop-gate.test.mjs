import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTempDir, trackTempDir, registerStopper, runCli, testEnv } from '../helpers.mjs';
import { fixtureModelIds, hookInput, makeFailingOpencodeBin, makeMainRepo, promptBodies, promptText, sessionCreateBodies, stateDirFor, writeFile, writeGlobalConfig } from '../f2b-helpers.mjs';
import { stopServer } from '../../plugins/opc/scripts/lib/server.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';

function setup(t, { scenario = 'stop-allow', gate = true, config = {}, extra = {} } = {}) {
  const cwd = makeMainRepo(t);
  const env = testEnv(t, { scenario, extra });
  writeGlobalConfig(env, { defaultModel: fixtureModelIds()[0], stopGate: { enabled: gate, model: null }, ...config });
  writeFile(cwd, 'math.js', 'export const divide = (a, b) => a / 0;\n');
  return { cwd, env };
}
function stop(env, cwd, fields = {}) {
  return runCli(['hook-stop'], { env, cwd, stdin: hookInput(cwd, { session_id: 'gate-session', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'I added divide() to math.js. GATE_MESSAGE_MARKER', ...fields }) });
}
function parseStdout(result) { return result.stdout.trim() ? JSON.parse(result.stdout) : null; }

test('a disabled gate allows without calling OpenCode', async (t) => {
  const { cwd, env } = setup(t, { gate: false });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(promptBodies(env).length, 0);
});

test('BLOCK: blocks the stop with decision=block and exit 0', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-block' });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /^opc stop gate: divide\(\) retorna a \/ 0 em math\.js/);
  assert.equal(Object.hasOwn(promptBodies(env)[0], 'format'), false);
  const text = promptText(promptBodies(env)[0]);
  assert.match(text, /GATE_MESSAGE_MARKER/);
  assert.match(text, /math\.js/);
  assert.match(text, /- ALLOW: <motivo breve>/);
  const [session] = sessionCreateBodies(env);
  assert.match(session.title, /^OPC: stop-gate/);
  assert.deepEqual(session.permissions[0], { action: '*', resource: '*', effect: 'deny' });
});

test('ALLOW: allows the stop silently', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-allow' });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
  assert.equal(promptBodies(env).length, 1);
});

test('output outside the contract allows with a warning (malformed)', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-malformed' });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /resposta inesperada/);
});

test('stop_hook_active allows without running the gate', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-block' });
  const result = await stop(env, cwd, { stop_hook_active: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(promptBodies(env).length, 0);
});

test('server unavailable allows with a systemMessage', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-block', config: { server: { bootTimeoutSec: 5 } } });
  const failBin = makeFailingOpencodeBin(t);
  const result = await stop({ ...env, PATH: `${failBin}${path.delimiter}${env.PATH}` }, cwd);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /não pôde ser executado/);
});

test('a denied gate model allows with a systemMessage', async (t) => {
  const [first] = fixtureModelIds();
  const policy = { ...structuredClone(DEFAULT_CONFIG.policy), models: { allow: [], deny: [first] } };
  const { cwd, env } = setup(t, { scenario: 'stop-block', config: { stopGate: { enabled: true, model: first }, policy } });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.decision, undefined);
  assert.match(payload.systemMessage, /não pôde ser executado/);
  assert.equal(sessionCreateBodies(env).length, 0);
});

test('without last_assistant_message the gate reads the last assistant text from transcript_path', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-allow' });
  const dir = trackTempDir(t, makeTempDir('opc-transcript-'));
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'TRANSCRIPT_MARKER edited math.js' }] } })}\n`);
  const result = await stop(env, cwd, { last_assistant_message: '', transcript_path: transcript });
  assert.equal(result.code, 0, result.stderr);
  assert.match(promptText(promptBodies(env)[0]), /TRANSCRIPT_MARKER/);
});

test('the Stop hook always notes active jobs of the session on stderr', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'review-slow', gate: false, extra: { FAKE_SLOW_MS: '60000' } });
  const started = await runCli(['review', '--background', '--json'], { env: { ...env, OPC_COMPANION_SESSION_ID: 'gate-session' }, cwd });
  assert.equal(started.code, 0, started.stderr);
  const { jobId } = JSON.parse(started.stdout);
  registerStopper(t, async () => {
    const cancelled = await runCli(['cancel', jobId], { env, cwd });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    return await stopServer({ stateDir: stateDirFor(env, cwd), workspaceRoot: cwd, config: {}, env, hasActiveJobs: () => false }, { force: true, confirmedByUser: true });
  });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0);
  assert.match(result.stderr, new RegExp(`\\[opc\\] a tarefa ${jobId} \\(review\\) ainda está em execução`));
  assert.equal(result.stdout, '');
});

test('gate keeps its text contract with tool-mode review configuration', async (t) => {
  const { cwd, env } = setup(t, { config: { review: { structuredOutput: 'tool' } } });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
  assert.equal(Object.hasOwn(promptBodies(env)[0], 'format'), false);
});

test('gate reports the fake API failure cause on stdout and stderr', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'stop-api-error' });
  const result = await stop(env, cwd);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.decision, undefined);
  for (const text of [payload.systemMessage, result.stderr]) assert.match(text, /STOP_GATE_FAILED \(provider\.payment-required: Erro do OpenCode\.\)/);
});
