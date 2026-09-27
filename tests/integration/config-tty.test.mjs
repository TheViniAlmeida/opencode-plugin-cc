import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace, testEnv, runCli, stopAllServers, writeGlobalConfig, readGlobalConfig, runInProcess, scriptedTTY,
} from '../helpers.mjs';

const MV = 'omniroute-mvalmeida';
const EQ = 'omniroute-work';

function setup(t, { config = null, git = true } = {}) {
  const ws = makeWorkspace(t, { git });
  const env = testEnv(t); // servers stopped by the F0 per-test cleanup
  if (config) writeGlobalConfig(env, config);
  return { ws, env };
}

test('--tty-confirm on a TTY: typed key confirms; mismatch refuses (exit 4)', async (t) => {
  const { ws, env } = setup(t, { config: { defaultProvider: MV } });
  const wrong = await runInProcess('config', ['set', 'policy.approver', 'claude', '--tty-confirm'], { env, cwd: ws, stdin: scriptedTTY(['policy.aprover']) });
  assert.equal(wrong.code, 4);
  assert.match(wrong.stderr, /did not match/);
  assert.equal(readGlobalConfig(env).policy, undefined);
  const ok = await runInProcess('config', ['set', 'policy.approver', 'claude', '--tty-confirm', '--json'], { env, cwd: ws, stdin: scriptedTTY(['policy.approver']) });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readGlobalConfig(env).policy.approver, 'claude');
  assert.match(ok.stderr, /chave travada/);
  const list = await runInProcess('config', ['add', 'policy.agents.deny', 'work-*', '--tty-confirm'], { env, cwd: ws, stdin: scriptedTTY(['policy.agents.deny']) });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(readGlobalConfig(env).policy.agents.deny, ['work-*']);
});

test('config init: scripted wizard writes the full config (numbered lists, filter, ranges)', async (t) => {
  const { ws, env } = setup(t, { git: false });
  fs.mkdirSync(path.join(ws, 'src'));
  fs.mkdirSync(path.join(ws, 'tests'));
  const answers = [
    '1',                        // provider: omniroute-mvalmeida (most models)
    'kimi-k3', '1',             // model: filter by text, pick the first match
    '1',                        // review model: none (use default)
    '1',                        // stop gate model: none
    '4',                        // variant: Nenhuma, low, medium, [high]
    '2', EQ,                    // allowed models: <provider>/*; deny provider omniroute-work
    '1', 'work-*',                // agents: all; deny work-*
    '1',                        // approver: user
    'n', 'n',                   // stop gate, auto delegation
    'Plugin Claude Code para OpenCode', '1-2', '1,3', // goal; dirs src/ + tests/; task types ask + review
    's', 's',                   // aliases fast / strong
    's',                        // save
  ];
  const r = await runInProcess('config', ['init', '--json'], { env, cwd: ws, stdin: scriptedTTY(answers) });
  assert.equal(r.code, 0, r.stderr);
  const cfg = readGlobalConfig(env);
  assert.equal(cfg.defaultProvider, MV);
  assert.equal(cfg.defaultModel, `${MV}/opencode-go/kimi-k3`);
  assert.equal(cfg.defaultVariant, 'high');
  assert.equal(cfg.reviewModel, null);
  assert.deepEqual(cfg.policy.models.allow, [`${MV}/*`]);
  assert.deepEqual(cfg.policy.providers.deny, [EQ]);
  assert.deepEqual(cfg.policy.agents, { allow: [], deny: ['work-*'] });
  assert.equal(cfg.policy.approver, 'user');
  assert.deepEqual(cfg.project, { goal: 'Plugin Claude Code para OpenCode', scope: ['src/', 'tests/'], taskTypes: ['ask', 'review'] });
  assert.equal(cfg.aliases.fast, `${MV}/opencode-go/qwen3.8-flash`);
  assert.equal(cfg.aliases.strong, `${MV}/opencode-go/qwen3.8-max`);
  assert.match(r.stderr, / 1\) omniroute-mvalmeida/);
});

test('config init without a TTY is refused (exit 2) and writes nothing', async (t) => {
  const { ws, env } = setup(t);
  const r = await runCli(['config', 'init'], { env, cwd: ws });
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /NOT_A_TTY/);
  assert.equal(readGlobalConfig(env), null);
});

test('config init: interrupted input writes nothing (exit 2)', async (t) => {
  const { ws, env } = setup(t);
  const r = await runInProcess('config', ['init'], { env, cwd: ws, stdin: scriptedTTY(['1']) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TTY_CLOSED|interrupted/);
  assert.equal(readGlobalConfig(env), null);
});
