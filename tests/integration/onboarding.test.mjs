import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, makeTempDir, testEnv, runCli, runInProcess, pipedStdin, stopAllServers, trackTempDir, writeGlobalConfig, readGlobalConfig,
} from '../helpers.mjs';

const MV = 'omniroute-personal';
const EQ = 'omniroute-work';

function setup(t, { config = null, env: extra = {} } = {}) {
  const ws = makeWorkspace(t);
  const env = testEnv(t, { extra }); // the tracked env object itself (a copy would escape the F0 cleanup)
  if (config) writeGlobalConfig(env, config);
  const cli = (args, opts = {}) => runCli(args, { env, cwd: ws, ...opts });
  const apply = (payload) => cli(['setup', 'apply', '--json', '--stdin'], { stdin: JSON.stringify(payload) });
  const draftFile = path.join(env.OPC_DATA_DIR, 'config.draft.json');
  return { ws, env, cli, apply, draftFile };
}
const completeBootstrap = {
  defaultProvider: MV, defaultModel: `${MV}/opencode-go/kimi-k3`, reviewModel: null, defaultVariant: null,
  stopGate: { model: null, enabled: false }, project: { goal: null }, aliases: {},
  policy: { models: { allow: [] }, agents: { allow: [] }, approver: 'user' }, server: { allowPrivateHttp: false },
};
const all = (r) => `${r.stdout}${r.stderr}`;

test('setup --json reports the onboarding state on first run', async (t) => {
  const { cli } = setup(t);
  const r = await cli(['setup', '--json']);
  const s = JSON.parse(r.stdout).onboarding;
  assert.equal(s.needed, true);
  assert.equal(s.mode, 'bootstrap');
  assert.equal(s.configExists, false);
  assert.equal(s.opencodeInstalled, true);
  assert.equal(s.opencodeVersion, '2.0.22');
  assert.deepEqual(s.connectedProviders.map((p) => p.id), [MV, EQ, 'anthropic', 'opencode']);
  assert.deepEqual(s.providerChoices, [MV, EQ, 'anthropic']);
  assert.equal(s.needsOtherProvider, true);
  assert.equal(s.lockedKeysEditable, true);
  assert.equal(s.draft.exists, false);
  assert.equal(s.nextStep, 'defaultProvider');
  const text = await cli(['setup']);
  assert.match(text.stdout, /## Onboarding/);
});

test('setup --json without opencode on PATH: install offer data', async (t) => {
  const bin = trackTempDir(t, makeTempDir());
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const { cli } = setup(t, { env: { PATH: bin } });
  const r = await cli(['setup', '--json']);
  assert.equal(r.code, 5);
  const report = JSON.parse(r.stdout);
  assert.equal(report.opencode.installed, false);
  assert.equal(report.server.status, 'skipped');
  assert.ok(report.nextSteps.some((step) => /Instale o OpenCode 2\.0\.22 ou mais novo/.test(step)));
  const s = report.onboarding;
  assert.equal(s.opencodeInstalled, false);
  assert.equal(s.npmAvailable, false);
  assert.equal(s.connectedProviders, null);
  assert.match(s.serverError, /não consultados.*falha no diagnóstico/i);
});

test('setup models: top suggestions, aliases, families and search', async (t) => {
  const { cli } = setup(t);
  const r = await cli(['setup', 'models', '--provider', MV, '--top', '3', '--query', 'opencode-go/qwen*', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.total, 7);
  assert.deepEqual(v.suggestions.map((m) => m.full), [`${MV}/cx/gpt-5.6-sol`, `${MV}/opencode-go/deepseek-v4.1-flash`, `${MV}/opencode-go/kimi-k2.6`]);
  assert.deepEqual(v.aliases, { fast: `${MV}/opencode-go/deepseek-v4.1-flash`, strong: `${MV}/opencode-go/kimi-k3` });
  assert.equal(v.families[0].glob, `${MV}/opencode-go/*`);
  assert.deepEqual(v.matches.map((m) => m.full), [`${MV}/opencode-go/qwen3.8-flash`, `${MV}/opencode-go/qwen3.8-max`]);
  const multiword = await cli(['setup', 'models', '--args-stdin', '--json'], { stdin: `--provider ${MV} --query 'deepseek v4'` });
  assert.equal(multiword.code, 0, multiword.stderr);
  assert.equal(JSON.parse(multiword.stdout).query, 'deepseek v4');
  assert.ok(JSON.parse(multiword.stdout).matches.some((m) => /deepseek-v4/i.test(m.full)));
  assert.equal((await cli(['setup', 'models', '--provider', 'openai'])).code, 2);
  assert.equal((await cli(['setup', 'models'])).code, 2);
});

test('guided flow: apply every step, commit atomically, effective config shown', async (t) => {
  const { ws, env, cli, apply, draftFile } = setup(t);
  const steps = [
    [{ defaultProvider: MV }, 'defaultModel'],
    [{ defaultModel: 'opencode-go/kimi-k3' }, 'reviewModels'],
    [{ reviewModel: null, stopGate: { model: null } }, 'defaultVariant'],
    [{ defaultVariant: 'high' }, 'allowedModels'],
    [{ policy: { models: { allow: [`${MV}/*`] }, providers: { deny: [EQ] } } }, 'allowedAgents'],
    [{ policy: { agents: { allow: [], deny: ['work-*'] } } }, 'approver'],
    [{ policy: { approver: 'user' } }, 'privateHttp'],
    [{ server: { allowPrivateHttp: false } }, 'behaviour'],
    [{ stopGate: { enabled: false }, delegation: { auto: false } }, 'project'],
    [{ project: { goal: "it's $(touch pwned) plugin", scope: ['plugins/'], taskTypes: ['review', 'ask'] } }, 'aliases'],
    [{ aliases: { fast: 'opencode-go/qwen3.8-flash', strong: 'opencode-go/qwen3.8-max' } }, null],
  ];
  for (const [payload, next] of steps) {
    const r = await apply(payload);
    assert.equal(r.code, 0, `${JSON.stringify(payload)}: ${all(r)}`);
    assert.equal(JSON.parse(r.stdout).nextStep, next);
  }
  assert.equal(fs.statSync(draftFile).mode & 0o777, 0o600);
  assert.equal(readGlobalConfig(env), null, 'nothing written before commit');
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, all(commit));
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.project.goal, "it's $(touch pwned) plugin");
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false, 'payload text is never executed');
  assert.deepEqual(cfg.policy.agents.deny, ['work-*']);
  assert.equal(cfg.aliases.strong, `${MV}/opencode-go/qwen3.8-max`);
  assert.equal(fs.existsSync(draftFile), false);
  const eff = JSON.parse((await cli(['config', 'show', '--effective', '--json'])).stdout);
  assert.equal(eff.config.defaultVariant, 'high');
});

test('setup commit refuses a denied default (exit 4); only the draft remains', async (t) => {
  const { env, cli, apply, draftFile } = setup(t);
  assert.equal((await apply({ ...completeBootstrap, defaultModel: `${EQ}/opencode-go/kimi-k3` })).code, 0);
  const pol = await apply({ policy: { providers: { deny: [EQ] } } });
  assert.equal(pol.code, 0);
  assert.equal(JSON.parse(pol.stdout).warnings[0].path, 'defaultModel');
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 4);
  assert.match(all(commit), /POLICY_DENIED/);
  assert.equal(readGlobalConfig(env), null);
  assert.ok(fs.existsSync(draftFile));
});

test('interruption leaves only the draft and setup resumes from the next step', async (t) => {
  const { env, cli, apply } = setup(t);
  await apply({ defaultProvider: MV });
  await apply({ defaultModel: 'opencode-go/kimi-k3' });
  assert.equal(readGlobalConfig(env), null);
  const s = JSON.parse((await cli(['setup', '--json'])).stdout).onboarding;
  assert.equal(s.draft.exists, true);
  assert.equal(s.nextStep, 'reviewModels');
  assert.equal(s.draft.values.defaultModel, `${MV}/opencode-go/kimi-k3`);
  const discard = await cli(['setup', 'discard', '--json']);
  assert.equal(JSON.parse(discard.stdout).discarded, true);
  assert.equal(JSON.parse((await cli(['setup', '--json'])).stdout).onboarding.draft.exists, false);
  assert.equal((await cli(['setup', 'commit'])).code, 2);
});

test('setup apply rejects malformed or conflicting payload sources without echoing input', async (t) => {
  const { ws, env } = setup(t);
  const invoke = (args, stdin = '') => runInProcess('setup', args, { env, cwd: ws, stdin: pipedStdin(stdin) });
  const secret = 'FAKE_SECRET_DO_NOT_ECHO';
  const malformed = await invoke(['apply', '--stdin'], `{"token":"${secret}",`);
  assert.equal(malformed.code, 2);
  assert.doesNotMatch(all(malformed), new RegExp(secret));
  assert.match(all(malformed), /JSON.*inválido|JSON.*válido/i, JSON.stringify(malformed));
  const conflicting = await invoke(['apply', '--stdin', '{"defaultProvider":"ignored"}'], '{}');
  assert.equal(conflicting.code, 2);
  assert.match(all(conflicting), /USAGE|uso:/i);
  assert.doesNotMatch(all(conflicting), /ignored/);
});

test('invalid payloads: unknown key, ambiguous and unknown models (exit 2)', async (t) => {
  const { cli, apply } = setup(t);
  assert.equal((await apply({ nonsense: true })).code, 2);
  await apply({ defaultProvider: MV });
  const amb = await apply({ defaultModel: 'opencode/big-pickle' });
  assert.equal(amb.code, 2);
  assert.match(all(amb), /AMBIGUOUS_MODEL/);
  assert.equal((await apply({ defaultModel: 'opencode-go/nope' })).code, 2);
  assert.equal((await apply({ defaultVariant: 'ultra' })).code, 2);
});

test('review-gate flags toggle config and report JSON and Markdown output', async (t) => {
  const { ws, env, cli } = setup(t, { config: { defaultModel: `${MV}/opencode-go/kimi-k3` } });
  const enabled = await cli(['setup', '--enable-review-gate', '--json']);
  assert.equal(enabled.code, 0, all(enabled));
  assert.deepEqual(JSON.parse(enabled.stdout).reviewGate, { enabled: true, changed: true });
  assert.equal(readGlobalConfig(env).stopGate.enabled, true);

  const markdown = await cli(['setup']);
  assert.equal(markdown.code, 0, all(markdown));
  assert.match(markdown.stdout, /Gate de parada: ativado/);

  const disabled = await cli(['setup', '--disable-review-gate', '--json']);
  assert.equal(disabled.code, 0, all(disabled));
  assert.deepEqual(JSON.parse(disabled.stdout).reviewGate, { enabled: false, changed: true });
  assert.equal(readGlobalConfig(env).stopGate.enabled, false);
});

test('after bootstrap: locked keys refused from Claude with the terminal command', async (t) => {
  const { cli, apply } = setup(t, { config: { defaultProvider: MV } });
  const s = JSON.parse((await cli(['setup', '--reconfigure', '--json'])).stdout).onboarding;
  assert.equal(s.mode, 'reconfigure');
  assert.equal(s.needed, true);
  assert.equal(s.lockedKeysEditable, false);
  assert.equal(s.nextStep, 'scope');
  const locked = await apply({ policy: { approver: 'claude' } });
  assert.equal(locked.code, 4);
  assert.match(all(locked), /LOCKED_KEY/);
  assert.match(all(locked), /opc config set policy\.approver '<valor>' --tty-confirm/);
  const ok = await apply({ scope: 'global', stopGate: { enabled: true } });
  assert.equal(ok.code, 0, all(ok));
  assert.ok(!JSON.parse(ok.stdout).remainingSteps.includes('allowedModels'));
});

test('bootstrap race: a global config created before commit makes locked values fail', async (t) => {
  const { env, cli, apply } = setup(t);
  assert.equal((await apply({ ...completeBootstrap, policy: { ...completeBootstrap.policy, approver: 'claude' } })).code, 0);
  assert.equal((await cli(['config', 'set', 'stopGate.enabled', 'false'])).code, 0);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 4);
  assert.match(all(commit), /LOCKED_KEY/);
  assert.equal(readGlobalConfig(env).policy, undefined);
});

test('reconfigure with workspace scope writes .opc.json', async (t) => {
  const { ws, cli, apply } = setup(t, { config: { defaultProvider: MV } });
  assert.equal((await apply({ scope: 'workspace' })).code, 0);
  assert.equal((await apply({ defaultModel: 'opencode-go/qwen3.8-max' })).code, 0);
  const globalOnly = await apply({ delegation: { auto: true } });
  assert.equal(globalOnly.code, 2);
  assert.equal((await apply({
    defaultProvider: MV, reviewModel: null, defaultVariant: null, project: { goal: null }, aliases: {},
  })).code, 0);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, all(commit));
  assert.equal(JSON.parse(commit.stdout).scope, 'workspace');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.opc.json'), 'utf8')).defaultModel, `${MV}/opencode-go/qwen3.8-max`);
});
