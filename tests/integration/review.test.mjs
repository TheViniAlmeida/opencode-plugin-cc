import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, runCli, testEnv } from '../helpers.mjs';
import { fixtureModelIds, gitIn, makeMainRepo, promptBodies, promptText, sessionCreateBodies, writeFile, writeGlobalConfig } from '../f2b-helpers.mjs';
import { REVIEW_OK_STRUCTURED } from '../fixtures/scenarios/review-ok.mjs';
import { DEFAULT_CONFIG } from '../../plugins/opc/scripts/lib/config.mjs';
import { parseFullId } from '../../plugins/opc/scripts/lib/models.mjs';

function setup(t, { scenario = 'review-ok', config = {}, extra = {} } = {}) {
  const cwd = makeMainRepo(t);
  const env = testEnv(t, { scenario, extra });
  const [model] = fixtureModelIds();
  writeGlobalConfig(env, { defaultModel: model, ...config });
  return { cwd, env, model };
}
function makeDirty(cwd) { writeFile(cwd, 'src/app.js', "export const value = 'REVIEW_DIFF_MARKER';\n"); }
const JOB_ID = /review-[a-z0-9]+-[a-z0-9]+/;

test('review --wait renders findings in severity order', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['review', '--wait'], { env, cwd });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# OPC Revisão\n/);
  assert.match(result.stdout, /Alvo: diff da árvore de trabalho/);
  assert.match(result.stdout, /Veredito: needs-attention/);
  assert.ok(result.stdout.indexOf('[critical]') < result.stdout.indexOf('[low]'));
  assert.match(result.stdout, /\(src\/app\.js:10-12\)/);
  assert.match(result.stdout, /\(src\/app\.js:2\)/);
  const [prompt] = promptBodies(env);
  assert.equal(Object.hasOwn(prompt, 'format'), false);
  assert.match(promptText(prompt), /Reply with only one JSON object/);
  assert.match(promptText(prompt), /REVIEW_DIFF_MARKER/);
  assert.match(promptText(prompt), /Use o contexto do repositório abaixo como evidência principal\./);
  const [session] = sessionCreateBodies(env);
  assert.match(session.title, /^OPC: review: /);
  assert.deepEqual(session.permissions[0], { action: '*', resource: '*', effect: 'deny' });
});

test('review --json returns the structured review', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['review', '--wait', '--json'], { env, cwd });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.jobId, JOB_ID); assert.equal(payload.status, 'completed');
  assert.deepEqual(payload.review, REVIEW_OK_STRUCTURED); assert.equal(payload.schemaValid, true);
  assert.match(payload.rendered, /Veredito: needs-attention/);
});

test('clean main branch reports nothing to review without calling OpenCode', async (t) => {
  const { cwd, env } = setup(t); const result = await runCli(['review', '--wait'], { env, cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nada para revisar: diff da branch em relação a main não tem alterações\./);
  assert.equal(promptBodies(env).length, 0);
});

test('review rejects focus and points to adversarial-review', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['review', '--wait', 'look', 'at', 'auth'], { env, cwd });
  assert.equal(result.code, 2); assert.match(result.stdout + result.stderr, /\/opc:adversarial-review look at auth/);
});

test('review refuses wait together with background', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['review', '--wait', '--background'], { env, cwd });
  assert.equal(result.code, 2); assert.match(result.stdout + result.stderr, /Use --wait ou --background/);
});

test('review outside git fails with usage error', async (t) => {
  const cwd = makeWorkspace(t, { git: false }); const env = testEnv(t, { scenario: 'review-ok' });
  writeGlobalConfig(env, { defaultModel: fixtureModelIds()[0] });
  const result = await runCli(['review', '--wait'], { env, cwd });
  assert.equal(result.code, 2); assert.match(result.stdout + result.stderr, /Este comando precisa ser executado dentro de um repositório Git/);
});

test('adversarial-review passes focus literally and uses adversarial prompt', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['adversarial-review', '--raw-args-stdin'], { env, cwd, stdin: `--wait focus on "race conditions", don't trust \`cache\` and $(touch pwned)\n` });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /^# OPC Revisão Adversarial\n/);
  const text = promptText(promptBodies(env)[0]); assert.match(text, /revisão adversarial de software/);
  assert.ok(text.includes('Foco do usuário: focus on "race conditions", don\'t trust `cache` and $(touch pwned)'), text);
  assert.equal((await import('node:fs')).existsSync((await import('node:path')).join(cwd, 'pwned')), false);
  assert.match(sessionCreateBodies(env)[0].title, /^OPC: adversarial-review: /);
  assert.equal(Object.hasOwn(promptBodies(env)[0], 'format'), false);
  assert.match(result.stdout, /Veredito: needs-attention/);
});

test('adversarial-review preserves focus whitespace and newlines in the prompt', async (t) => {
  const { cwd, env } = setup(t);
  makeDirty(cwd);
  // --raw-args-stdin is not shell-parsed: quotes would be part of the focus. The separator after the
  // leading flag run is not content; spaces and newlines inside and after the focus are.
  const focus = 'inspect auth  \nwith care\n\n';
  const result = await runCli(['adversarial-review', '--raw-args-stdin'], {
    env, cwd, stdin: `--wait ${focus}\n`,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(promptText(promptBodies(env)[0]).includes(`Foco do usuário: ${focus}`));
});

test('adversarial-review treats whitespace-only focus as absent', async (t) => {
  const { cwd, env } = setup(t);
  makeDirty(cwd);
  const result = await runCli(['adversarial-review', '--raw-args-stdin'], { env, cwd, stdin: '--wait   \n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(promptText(promptBodies(env)[0]), /Nenhum foco adicional informado\./);
});

test('review --json stays JSON when the read-only bridge rejects a permission request', async (t) => {
  // Review is read-only: the bridge rejects permission requests and questions at once, so the job
  // never waits; the --json output must still be a single JSON object.
  const { cwd, env } = setup(t, { scenario: 'review-permission-ask' });
  makeDirty(cwd);
  const result = await runCli(['review', '--wait', '--json'], { env, cwd });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'completed');
  assert.doesNotMatch(result.stdout, /^# /m);
  assert.match(result.stderr, /recusada automaticamente: perfil somente leitura/);
});

test('review refuses to start inside OpenCode server', async (t) => {
  const { cwd, env } = setup(t, { extra: { OPC_INSIDE_SERVER: '1' } }); makeDirty(cwd);
  const result = await runCli(['review', '--wait'], { env, cwd });
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /INSIDE_SERVER|delegação não pode ser recursiva/);
  assert.equal(sessionCreateBodies(env).length, 0);
});

test('background review and result render the review', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const started = await runCli(['review', '--background'], { env, cwd }); assert.equal(started.code, 0, started.stderr);
  const jobId = started.stdout.match(JOB_ID)?.[0]; assert.ok(jobId, started.stdout);
  assert.match(started.stdout, new RegExp(`/opc:status ${jobId}`)); assert.match(started.stdout, new RegExp(`/opc:result ${jobId}`));
  const waited = await runCli(['status', jobId, '--wait', '--timeout-ms', '60000'], { env, cwd }); assert.equal(waited.code, 0, waited.stderr);
  const result = await runCli(['result', jobId], { env, cwd }); assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /# OPC Revisão/); assert.match(result.stdout, /Veredito: needs-attention/);
});

test('StructuredOutputError degrades to raw text and exits 7', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'review-structured-error' }); makeDirty(cwd);
  const result = await runCli(['review', '--wait'], { env, cwd }); assert.equal(result.code, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /O OpenCode não retornou uma saída estruturada válida\./); assert.match(result.stdout, /RAW_REVIEW_TEXT/);
});

test('large diff is chunked under inline limit', async (t) => {
  const { cwd, env } = setup(t); const bigBody = (tag, index) => Array.from({ length: 400 }, (_, line) => `export const ${tag}_${index}_${line} = '${'x'.repeat(40)}';`).join('\n') + '\n';
  for (let index = 0; index < 30; index += 1) writeFile(cwd, `big/file-${index}.js`, bigBody('OLD', index));
  writeFile(cwd, 'small/s0.js', 'export const s0 = 1;\n'); gitIn(cwd, ['add', '-A']); gitIn(cwd, ['commit', '-m', 'base']);
  for (let index = 0; index < 30; index += 1) writeFile(cwd, `big/file-${index}.js`, bigBody('NEW', index));
  writeFile(cwd, 'small/s0.js', "export const s0 = 'SMALL_MARKER_0';\n");
  const result = await runCli(['review', '--wait'], { env, cwd }); assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[opc\] diff tem \d+ bytes; enviando estatísticas e \d+ de 31 diffs de arquivos/);
  const text = promptText(promptBodies(env)[0]); assert.ok(Buffer.byteLength(text) < 450 * 1024);
  assert.match(text, /## Estatísticas do diff/); assert.match(text, /## Arquivos omitidos/); assert.match(text, /SMALL_MARKER_0/);
  assert.match(text, /leia esses arquivos alterados com a ferramenta read/);
});

test('reviewModel routes the review turn', async (t) => {
  const ids = fixtureModelIds(); if (ids.length < 2) return t.skip('fixture has a single model');
  const { cwd, env } = setup(t, { config: { defaultModel: ids[0], reviewModel: ids[1] } }); makeDirty(cwd);
  const result = await runCli(['review', '--wait'], { env, cwd }); assert.equal(result.code, 0, result.stderr);
  const expected = parseFullId(ids[1]); assert.deepEqual(sessionCreateBodies(env)[0].model, { providerID: expected.providerID, id: expected.modelID });
});

test('denied review model exits 4 before creating a session', async (t) => {
  const [first] = fixtureModelIds(); const policy = { ...structuredClone(DEFAULT_CONFIG.policy), models: { allow: [], deny: [first] } };
  const { cwd, env } = setup(t, { config: { policy } }); makeDirty(cwd);
  const result = await runCli(['review', '--wait', '--model', first], { env, cwd });
  assert.equal(result.code, 4, result.stdout + result.stderr); assert.equal(sessionCreateBodies(env).length, 0);
});

test('estimate recommends waiting for a tiny change without starting server', async (t) => {
  const { cwd, env } = setup(t); makeDirty(cwd);
  const result = await runCli(['review', '--estimate', '--json'], { env, cwd }); assert.equal(result.code, 0, result.stderr);
  const estimate = JSON.parse(result.stdout); assert.equal(estimate.target.mode, 'working-tree'); assert.equal(estimate.files, 1);
  assert.equal(estimate.recommendation, 'wait'); assert.equal(promptBodies(env).length, 0);
});

for (const command of ['review', 'adversarial-review']) {
  test(`${command} migrates tool config and requests JSON in text`, async (t) => {
    const { cwd, env } = setup(t, { config: { review: { structuredOutput: 'tool' } } });
    makeDirty(cwd);
    const result = await runCli([command, '--wait', '--json'], { env, cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).review, REVIEW_OK_STRUCTURED);
    const [prompt] = promptBodies(env);
    assert.equal(Object.hasOwn(prompt, 'format'), false);
    assert.match(prompt.text, /Reply with only one JSON object/);
    assert.match(prompt.text, /"required":\["verdict","summary","findings","next_steps"\]/);
  });
  test(`${command} default text mode completes when the fake drops all SSE events`, async (t) => {
    const { cwd, env } = setup(t, { scenario: 'review-dropped-events' });
    makeDirty(cwd);
    const result = await runCli([command, '--wait', '--json'], { env, cwd });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).review, REVIEW_OK_STRUCTURED);
    assert.equal(Object.hasOwn(promptBodies(env)[0], 'format'), false);
  });
}

test('legacy tool config with lost SSE still recovers text from the session', async (t) => {
  const { cwd, env } = setup(t, { scenario: 'review-dropped-events', config: { review: { structuredOutput: 'tool' } } });
  makeDirty(cwd);
  const started = performance.now();
  const result = await runCli(['review', '--wait', '--json'], { env, cwd, timeoutMs: 40_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).review, REVIEW_OK_STRUCTURED);
  assert.ok(performance.now() - started < 35_000);
});
