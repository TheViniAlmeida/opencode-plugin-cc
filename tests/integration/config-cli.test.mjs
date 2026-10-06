import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, testEnv, runCli, writeGlobalConfig, readGlobalConfig, writeWorkspaceConfig, runInProcess, scriptedTTY,
} from '../helpers.mjs';

const MV = 'omniroute-personal';
const EQ = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [EQ] }, agents: { allow: [], deny: ['work-*'] } } };

function setup(t, { config = null, scenario = 'ok' } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { scenario }); // servers stopped by the F0 per-test cleanup
  if (config) writeGlobalConfig(env, config);
  return { ws, env, cli: (args, opts = {}) => runCli(args, { env, cwd: ws, ...opts }) };
}
const all = (r) => `${r.stdout}${r.stderr}`;

test('path and get work without any config', async (t) => {
  const { env, cli } = setup(t);
  const p = JSON.parse((await cli(['config', 'path', '--json'])).stdout);
  assert.equal(p.global, path.join(env.OPC_DATA_DIR, 'config.json'));
  assert.equal(p.draft, path.join(env.OPC_DATA_DIR, 'config.draft.json'));
  const get = await cli(['config', 'get', 'defaultModel']);
  assert.equal(get.code, 0);
  assert.equal(get.stdout, 'defaultModel = null\n');
  assert.equal((await cli(['config', 'get', 'no.such.key'])).code, 2);
});

test('get masks secret-like settings in JSON and text; locked recovery never echoes a value', async (t) => {
  const { ws, env } = setup(t, { config: { server: { configOverride: { provider: { x: { options: { apiKey: 'credential-value-marker' } } } } } } });
  const json = await runInProcess('config', ['get', 'server.configOverride.provider.x.options.apiKey', '--json'], { env, cwd: ws });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).value, '***');
  const text = await runInProcess('config', ['get', 'server.configOverride.provider.x.options.apiKey'], { env, cwd: ws });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /\*\*\*/);
  assert.doesNotMatch(text.stdout + json.stdout, /credential-value-marker/);
  const locked = await runInProcess('config', ['set', 'server.configOverride', 'credential-value-marker'], { env, cwd: ws });
  assert.equal(locked.code, 4);
  assert.match(locked.stderr, /'\<valor\>'/);
  assert.doesNotMatch(locked.stderr, /credential-value-marker/);
});

test('validate renders structured errors for a config shape rejected during load', async (t) => {
  const { ws, env } = setup(t, { config: { project: { goal: 42 } } });
  const r = await runInProcess('config', ['validate', '--json'], { env, cwd: ws });
  assert.equal(r.code, 2);
  const view = JSON.parse(r.stdout);
  assert.equal(view.kind, 'validate');
  assert.equal(view.valid, false);
  assert.equal(view.serverChecked, false);
  assert.deepEqual(view.warnings, []);
  assert.ok(view.errors.some((e) => e.path === 'project.goal' && e.code === 'INVALID_VALUE'));
  const text = await runInProcess('config', ['validate'], { env, cwd: ws });
  assert.equal(text.code, 2);
  assert.match(text.stdout, /project\.goal/);
});

test('setup --stop-server works with invalid config and reports the defaults fallback', async (t) => {
  const { ws, env } = setup(t, { config: { project: { goal: 42 } } });
  for (const argv of [['--stop-server', '--json'], ['--json', '--stop-server']]) {
    const r = await runInProcess('setup', argv, { env, cwd: ws });
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    const view = JSON.parse(r.stdout);
    assert.equal(view.mode, 'stop');
    assert.match(view.warnings?.join(' ') ?? '', /defaults/i);
  }
  const text = await runInProcess('setup', ['--stop-server'], { env, cwd: ws });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Avisos:[\s\S]*defaults/i);
});

test('offline policy check rejects a TTY-confirmed policy edit that denies an effective model', async (t) => {
  const { ws, env } = setup(t, { config: { defaultModel: `${EQ}/opencode-go/kimi-k3` } });
  const globalPath = path.join(env.OPC_DATA_DIR, 'config.json');
  const before = fs.readFileSync(globalPath, 'utf8');
  const r = await runInProcess('config', ['add', 'policy.providers.deny', EQ, '--workspace', '--tty-confirm'], {
    env, cwd: ws, stdin: scriptedTTY(['policy.providers.deny']),
  });
  assert.equal(r.code, 4, all(r));
  assert.match(all(r), /POLICY_DENIED/);
  assert.doesNotMatch(all(r), /LOCKED_KEY/);
  assert.match(all(r), /policy\.providers\.deny: omniroute-work/);
  assert.equal(fs.existsSync(path.join(ws, '.opc.json')), false, 'denied policy edit is not written');
  assert.equal(fs.readFileSync(globalPath, 'utf8'), before);
  assert.equal(fs.existsSync(env.FAKE_OPENCODE_STATE), false, 'offline check never boots a server');
});

for (const edit of [['unset', 'defaultModel'], ['set', 'defaultModel', 'null']]) {
  const operation = edit[0] === 'unset' ? 'unset' : 'set null';
  test(`${operation} of workspace override checks the resulting effective policy before writing`, async (t) => {
    const { ws, env, cli } = setup(t, { config: { policy: WORLD.policy, defaultModel: `${EQ}/opencode-go/kimi-k3` } });
    const workspacePath = writeWorkspaceConfig(ws, { defaultModel: `${MV}/opencode-go/kimi-k3` });
    const globalPath = path.join(env.OPC_DATA_DIR, 'config.json');
    const beforeGlobal = fs.readFileSync(globalPath, 'utf8');
    const beforeWorkspace = fs.readFileSync(workspacePath, 'utf8');
    const r = await cli(['config', ...edit, '--workspace']);
    assert.equal(r.code, 4, all(r));
    assert.match(all(r), /POLICY_DENIED/);
    assert.match(all(r), /policy\.providers\.deny: omniroute-work/);
    assert.equal(fs.readFileSync(workspacePath, 'utf8'), beforeWorkspace);
    assert.equal(fs.readFileSync(globalPath, 'utf8'), beforeGlobal);
  });
}

test('set scalar without server: file created with mode 0600', async (t) => {
  const { env, cli } = setup(t);
  const r = await cli(['config', 'set', 'stopGate.enabled', 'true', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readGlobalConfig(env).stopGate.enabled, true);
  assert.equal(fs.statSync(path.join(env.OPC_DATA_DIR, 'config.json')).mode & 0o777, 0o600);
  assert.equal((await cli(['config', 'set', 'jobs.maxActive', 'lots'])).code, 2);
  assert.equal((await cli(['config', 'set', 'nope.key', '1'])).code, 2);
});

test('model ids: short name gets the default provider, ambiguity, "=" prefix, unknown, variant', async (t) => {
  const { env, cli } = setup(t, { config: { defaultProvider: MV } });
  let r = await cli(['config', 'set', 'defaultModel', 'opencode-go/kimi-k3', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).value, `${MV}/opencode-go/kimi-k3`);
  assert.equal(JSON.parse(r.stdout).setting, 'defaultModel', 'JSON never uses a "key" field (redact() masks it)');
  r = await cli(['config', 'set', 'defaultModel', 'opencode/big-pickle']);
  assert.equal(r.code, 2);
  assert.match(all(r), /AMBIGUOUS_MODEL/);
  assert.match(all(r), /=opencode\/big-pickle/);
  r = await cli(['config', 'set', 'defaultModel', '=opencode/big-pickle', '--json']);
  assert.equal(JSON.parse(r.stdout).value, 'opencode/big-pickle');
  r = await cli(['config', 'set', 'defaultModel', `${MV}/opencode/big-pickle`, '--json']);
  assert.equal(JSON.parse(r.stdout).value, `${MV}/opencode/big-pickle`);
  r = await cli(['config', 'set', 'defaultModel', 'opencode-go/does-not-exist']);
  assert.equal(r.code, 2);
  assert.match(all(r), /UNKNOWN_MODEL/);
  await cli(['config', 'set', 'defaultModel', 'opencode-go/kimi-k3']);
  assert.equal((await cli(['config', 'set', 'defaultVariant', 'high'])).code, 0);
  r = await cli(['config', 'set', 'defaultVariant', 'ultra']);
  assert.equal(r.code, 2);
  assert.match(all(r), /UNKNOWN_VARIANT/);
  assert.equal(readGlobalConfig(env).defaultVariant, 'high');
});

test('aliases: expanded on input, alias names kept in model references, lists', async (t) => {
  const { env, cli } = setup(t, { config: { defaultProvider: MV } });
  assert.equal((await cli(['config', 'set', 'aliases.fast', 'opencode-go/deepseek-v4.1-flash'])).code, 0);
  assert.equal((await cli(['config', 'set', 'reviewModel', 'fast'])).code, 0);
  assert.equal((await cli(['config', 'add', 'routing.tasks.ask', 'fast'])).code, 0);
  assert.equal((await cli(['config', 'add', 'routing.tasks.ask', 'opencode-go/kimi-k3'])).code, 0);
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.aliases.fast, `${MV}/opencode-go/deepseek-v4.1-flash`);
  assert.equal(cfg.reviewModel, 'fast');
  assert.deepEqual(cfg.routing.tasks.ask, ['fast', `${MV}/opencode-go/kimi-k3`]);
  assert.equal((await cli(['config', 'remove', 'routing.tasks.ask', 'fast'])).code, 0);
  const missing = await cli(['config', 'remove', 'routing.tasks.ask', 'fast']);
  assert.equal(missing.code, 2);
  assert.match(all(missing), /NOT_IN_LIST/);
  assert.equal((await cli(['config', 'unset', 'reviewModel'])).code, 0);
  assert.equal(readGlobalConfig(env).reviewModel, undefined);
});

test('validate: unknown model, invalid variant, broken alias, secret-looking key', async (t) => {
  const { cli } = setup(t, {
    config: {
      defaultModel: `${MV}/opencode-go/removed-model`,
      defaultVariant: 'ultra',
      aliases: { gone: `${MV}/opencode-go/also-removed` },
      reviewModel: 'gone',
      server: { configOverride: { share: 'disabled', provider: { x: { options: { apiKey: 'sk-should-not-be-here' } } } } },
      githubToken: 'nope',
    },
  });
  const r = await cli(['config', 'validate', '--json']);
  assert.equal(r.code, 2);
  const view = JSON.parse(r.stdout);
  const errors = view.errors.map((e) => `${e.path}:${e.code}`);
  assert.ok(errors.includes('defaultModel:UNKNOWN_MODEL'), errors.join());
  assert.ok(errors.includes('defaultVariant:UNKNOWN_VARIANT'), errors.join());
  assert.ok(errors.includes('reviewModel:BROKEN_ALIAS'), errors.join());
  assert.ok(errors.includes('aliases.gone:UNKNOWN_MODEL'), errors.join());
  const secretWarnings = view.warnings.filter((w) => w.code === 'SECRET_LIKE_KEY').map((w) => w.path);
  assert.ok(secretWarnings.includes('githubToken'));
  assert.ok(secretWarnings.includes('server.configOverride.provider.x.options.apiKey'));
  assert.doesNotMatch(r.stdout, /sk-should-not-be-here/);
  const text = await cli(['config', 'show']);
  assert.doesNotMatch(text.stdout, /sk-should-not-be-here/);
});

test('validate: policy-denied default gives exit 4; clean config gives exit 0', async (t) => {
  const denied = setup(t, { config: { ...WORLD, defaultModel: `${EQ}/opencode-go/kimi-k3` } });
  const r = await denied.cli(['config', 'validate', '--json']);
  assert.equal(r.code, 4);
  assert.equal(JSON.parse(r.stdout).errors[0].code, 'POLICY_DENIED');
  const clean = setup(t, { config: { ...WORLD, defaultModel: `${MV}/opencode-go/kimi-k3` } });
  const ok = await clean.cli(['config', 'validate', '--json']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).valid, true);
});

test('policy blocks explicit use of denied models and agents (exit 4)', async (t) => {
  const { env, cli } = setup(t, { config: WORLD });
  const model = await cli(['config', 'set', 'defaultModel', `${EQ}/opencode-go/kimi-k3`]);
  assert.equal(model.code, 4, all(model));
  assert.match(all(model), /policy\.providers\.deny: omniroute-work/);
  const agent = await cli(['config', 'set', 'defaultAgent', 'work-reviewer']);
  assert.equal(agent.code, 4, all(agent));
  assert.match(all(agent), /policy\.agents\.deny: work-\*/);
  const alias = await cli(['config', 'set', 'aliases.eq', `${EQ}/opencode-go/kimi-k3`]);
  assert.equal(alias.code, 4, 'aliases pass through the policy too');
  assert.equal(readGlobalConfig(env).defaultModel, undefined, 'nothing written');
});

test('pinned-denied-model: an agent whose pinned model is denied cannot become the default (exit 4)', async (t) => {
  const { cli } = setup(t, { config: WORLD, scenario: 'pinned-denied-model' });
  const r = await cli(['config', 'set', 'defaultAgent', 'pinned-reviewer']);
  assert.equal(r.code, 4, all(r));
  assert.match(all(r), /POLICY_DENIED/);
  assert.match(all(r), /modelo fixado omniroute-work\/opencode-go\/kimi-k3/);
  assert.equal((await cli(['config', 'set', 'defaultAgent', 'docs-writer'])).code, 2, 'subagent-only agent cannot be the session agent');
  assert.equal((await cli(['config', 'set', 'defaultAgent', 'build'])).code, 0);
});

test('locked keys are refused without a TTY (exit 4) and nothing is written', async (t) => {
  const { env, cli } = setup(t);
  let r = await cli(['config', 'set', 'policy.models.deny', 'x/*']);
  assert.equal(r.code, 4);
  assert.match(all(r), /LOCKED_KEY/);
  assert.match(all(r), /opc config set policy\.models\.deny '<valor>' --tty-confirm/);
  assert.doesNotMatch(all(r), /'x\/\*'/);
  r = await cli(['config', 'set', 'policy.models.deny', 'x/*', '--tty-confirm']);
  assert.equal(r.code, 4);
  assert.match(all(r), /LOCKED_KEY/);
  assert.match(all(r), /--tty-confirm exige um terminal interativo/);
  r = await cli(['config', 'unset', 'policy.approver']);
  assert.equal(r.code, 4, 'unset of a locked key is locked too');
  r = await cli(['config', 'set', 'server.configOverride', '{"share":"auto"}']);
  assert.equal(r.code, 4);
  assert.equal(readGlobalConfig(env), null);
});

test('workspace edits: preference keys go to .opc.json; global-only keys refused', async (t) => {
  const { ws, cli } = setup(t);
  const r = await cli(['config', 'set', 'defaultModel', `${MV}/opencode-go/kimi-k3`, '--workspace', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.opc.json'), 'utf8')).defaultModel, `${MV}/opencode-go/kimi-k3`);
  const approver = await cli(['config', 'set', 'policy.approver', 'claude', '--workspace']);
  assert.equal(approver.code, 2);
  assert.match(all(approver), /GLOBAL_ONLY_KEY/);
  const jobs = await cli(['config', 'set', 'jobs.maxActive', '64', '--workspace']);
  assert.equal(jobs.code, 2);
});

test('restrictive merge: .opc.json can only narrow the global policy', async (t) => {
  const { ws, cli } = setup(t, { config: { policy: { models: { allow: [`${MV}/*`] }, providers: { deny: [EQ] } } } });
  writeWorkspaceConfig(ws, {
    policy: { models: { allow: [`${MV}/opencode-go/kimi-*`, 'anthropic/*'], deny: ['*/qwen*'] }, approver: 'claude' },
    permissionProfiles: { yolo: [{ action: '*', resource: '*', effect: 'allow' }] },
  });
  const eff = JSON.parse((await cli(['config', 'show', '--effective', '--json'])).stdout);
  assert.deepEqual(eff.config.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(eff.config.policy.models.allowWorkspace, [`${MV}/opencode-go/kimi-*`, 'anthropic/*']);
  assert.equal(eff.config.policy.approver, 'user');
  assert.deepEqual(eff.config.permissionProfiles, {});
  const warned = eff.warnings.map((w) => w.path);
  for (const p of ['policy.approver', 'permissionProfiles', 'policy.models.allow']) assert.ok(warned.includes(p), p);
  const allowed = JSON.parse((await cli(['models', '--allowed', '--json'])).stdout).models.map((m) => m.full);
  assert.deepEqual(allowed, [`${MV}/opencode-go/kimi-k2.6`, `${MV}/opencode-go/kimi-k3`], 'anthropic/* cannot widen the global allow');
});

test('arguments via --args-stdin are never expanded by a shell', async (t) => {
  const { ws, env, cli } = setup(t);
  const r = await cli(['config', '--args-stdin'], { stdin: 'set project.goal "it\'s $(touch pwned) `id` ok"\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readGlobalConfig(env).project.goal, "it's $(touch pwned) `id` ok");
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
  // Unquoted prose apostrophes stay literal (F0 splitArgString: ' between letters never opens a quote).
  const prose = await cli(['config', '--args-stdin'], { stdin: "set project.goal can't-won't\n" });
  assert.equal(prose.code, 0, prose.stderr);
  assert.equal(readGlobalConfig(env).project.goal, "can't-won't");
});
