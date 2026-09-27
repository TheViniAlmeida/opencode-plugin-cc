import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, stopAllServers, writeGlobalConfig } from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [EQ] }, agents: { allow: [], deny: ['work-*'] } } };
const SECRET_MARKERS = /FIXTURE-|sk-omr|sk-ant|sk-FIXTURE|Bearer /;

function setup(t, { scenario = 'ok', config = null } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { scenario }); // the F0 per-test cleanup stops this env × workspace server before removing the dirs
  if (config) writeGlobalConfig(env, config);
  return { ws, env };
}
const noSecrets = (r) => {
  assert.doesNotMatch(r.stdout, SECRET_MARKERS);
  assert.doesNotMatch(r.stderr, SECRET_MARKERS);
};

test('providers: connected by default, --all shows the catalog, keys never printed', async (t) => {
  const { ws, env } = setup(t);
  const def = await runCli(['providers', '--json'], { env, cwd: ws });
  assert.equal(def.code, 0, def.stderr);
  const view = JSON.parse(def.stdout);
  assert.deepEqual(view.providers.map((p) => p.id), ['anthropic', MV, EQ, 'opencode']);
  assert.equal(view.providers.find((p) => p.id === MV).modelCount, 7);
  assert.equal(view.providers.find((p) => p.id === MV).defaultModel, `${MV}/opencode-go/deepseek-v4.1-flash`);
  const all = await runCli(['providers', '--all', '--json'], { env, cwd: ws });
  assert.equal(JSON.parse(all.stdout).providers.length, 5);
  assert.equal(JSON.parse(all.stdout).providers.find((p) => p.id === 'openai').connected, false);
  const text = await runCli(['providers', '--all'], { env, cwd: ws });
  assert.match(text.stdout, /# Providers do OpenCode \(catálogo completo\)/);
  for (const r of [def, all, text]) noSecrets(r);
});

test('models: listing, provider filter, --all, --verbose, no model headers leak', async (t) => {
  const { ws, env } = setup(t);
  const def = JSON.parse((await runCli(['models', '--json'], { env, cwd: ws })).stdout);
  assert.equal(def.models.length, 14);
  assert.ok(def.models.every((m) => m.connected));
  const mv = await runCli(['models', MV, '--verbose', '--json'], { env, cwd: ws });
  const kimi = JSON.parse(mv.stdout).models.find((m) => m.full === `${MV}/opencode-go/kimi-k3`);
  assert.deepEqual(kimi.variants, ['low', 'medium', 'high']);
  assert.deepEqual(kimi.limit, { context: 262144, output: 32768 });
  assert.equal(kimi.modelID, 'opencode-go/kimi-k3', 'model id with slashes kept intact');
  const verboseText = await runCli(['models', MV, '--verbose'], { env, cwd: ws });
  assert.match(verboseText.stdout, /Custo in\/out/);
  const all = JSON.parse((await runCli(['models', '--all', '--json'], { env, cwd: ws })).stdout);
  assert.equal(all.models.length, 15);
  const notConnected = await runCli(['models', 'openai'], { env, cwd: ws });
  assert.equal(notConnected.code, 2);
  assert.match(notConnected.stdout + notConnected.stderr, /not connected; use --all/);
  const unknown = await runCli(['models', 'nope'], { env, cwd: ws });
  assert.equal(unknown.code, 2);
  const longUnknown = 'a-very-long-unrecognized-provider-name';
  const longUnknownResult = await runCli(['models', longUnknown], { env, cwd: ws });
  assert.equal(longUnknownResult.code, 2);
  assert.match(longUnknownResult.stdout + longUnknownResult.stderr, /unknown provider "a-very-long…"/);
  assert.doesNotMatch(longUnknownResult.stdout + longUnknownResult.stderr, /unrecognized-provider-name/);
  for (const r of [mv, verboseText]) noSecrets(r);
});

test('--allowed hides denied entries and marks them with the rule', async (t) => {
  const { ws, env } = setup(t, { config: WORLD });
  const models = JSON.parse((await runCli(['models', '--allowed', '--json'], { env, cwd: ws })).stdout).models;
  assert.equal(models.length, 11);
  assert.ok(models.every((m) => m.providerID !== EQ));
  const marked = JSON.parse((await runCli(['models', EQ, '--json'], { env, cwd: ws })).stdout).models;
  assert.ok(marked.every((m) => m.allowed === false && /policy\.providers\.deny: omniroute-work/.test(m.rule)));
  const agents = JSON.parse((await runCli(['agents', '--allowed', '--json'], { env, cwd: ws })).stdout).agents;
  assert.deepEqual(agents.map((a) => a.name), ['build', 'docs-writer', 'explore', 'general', 'plan']);
});

test('agents: hidden only with --verbose, mode filter, pinned model shown', async (t) => {
  const { ws, env } = setup(t);
  const def = JSON.parse((await runCli(['agents', '--json'], { env, cwd: ws })).stdout).agents.map((a) => a.name);
  assert.deepEqual(def, ['build', 'docs-writer', 'explore', 'general', 'plan', 'work-deploy', 'work-reviewer']);
  const primary = JSON.parse((await runCli(['agents', '--mode', 'primary', '--json'], { env, cwd: ws })).stdout).agents.map((a) => a.name);
  assert.deepEqual(primary, ['build', 'plan', 'work-reviewer']);
  const verbose = JSON.parse((await runCli(['agents', '--verbose', '--json'], { env, cwd: ws })).stdout).agents;
  assert.ok(verbose.some((a) => a.name === 'title' && a.hidden));
  assert.equal(verbose.find((a) => a.name === 'docs-writer').pinnedModel, `${MV}/opencode-go/qwen3.8-max`);
  const bad = await runCli(['agents', '--mode', 'robot'], { env, cwd: ws });
  assert.equal(bad.code, 2);
});

test('scenario pinned-denied-model: agent and command pinning a denied model are marked denied', async (t) => {
  const { ws, env } = setup(t, { scenario: 'pinned-denied-model', config: WORLD });
  const verbose = JSON.parse((await runCli(['agents', '--verbose', '--json'], { env, cwd: ws })).stdout).agents;
  const pinned = verbose.find((a) => a.name === 'pinned-reviewer');
  assert.equal(pinned.allowed, false);
  assert.match(pinned.rule, /^pinned model omniroute-work\/opencode-go\/kimi-k3/);
  const allowed = JSON.parse((await runCli(['agents', '--allowed', '--json'], { env, cwd: ws })).stdout).agents;
  assert.ok(!allowed.some((a) => a.name === 'pinned-reviewer'));
  const commands = JSON.parse((await runCli(['catalog', 'commands', '--json'], { env, cwd: ws })).stdout).items;
  const release = commands.find((c) => c.name === 'work-release');
  assert.equal(release.allowed, false);
  assert.match(release.rule, /pinned model omniroute-work\/cx\/gpt-5\.5/);
});

test('catalog lists commands and skills (never skill content)', async (t) => {
  const { ws, env } = setup(t);
  const commands = JSON.parse((await runCli(['catalog', 'commands', '--json'], { env, cwd: ws })).stdout).items;
  assert.deepEqual(commands.map((c) => c.name), ['brainstorm', 'docs', 'gitlab:list-mrs', 'init', 'review']);
  assert.equal(commands.find((c) => c.name === 'docs').model, `${MV}/opencode-go/qwen3.8-max`);
  const skillsJson = await runCli(['catalog', 'skills', '--json'], { env, cwd: ws });
  assert.equal(skillsJson.code, 0);
  assert.ok(JSON.parse(skillsJson.stdout).items.every((item) => !Object.hasOwn(item, 'content')));
  const skills = await runCli(['catalog', 'skills'], { env, cwd: ws });
  assert.equal(skills.code, 0);
  assert.match(skills.stdout, /release-notes/);
  assert.doesNotMatch(skills.stdout, /Summarize commits/);
  const usage = await runCli(['catalog'], { env, cwd: ws });
  assert.equal(usage.code, 2);
});
