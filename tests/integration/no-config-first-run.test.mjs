// Master Review Focus 3: first use without config.json and without .opc.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, testEnv, runCli, fixtureData } from '../helpers.mjs';

const STACK_TRACE = /\n\s+at .+\.m?js:\d+:\d+/;

test('no-config-first-run: discovery, config and setup work with OpenCode defaults', async (t) => {
  const ws = makeWorkspace(t);
  const env = testEnv(t);
  assert.equal(fs.existsSync(path.join(env.OPC_DATA_DIR, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(ws, '.opc.json')), false);

  const cases = [
    ['providers', '--json'],
    ['models', '--json'],
    ['models', '--allowed', '--json'],
    ['agents', '--json'],
    ['catalog', 'commands', '--json'],
    ['catalog', 'skills', '--json'],
    ['config', 'show', '--effective', '--json'],
    ['config', 'get', 'defaultModel', '--json'],
    ['config', 'validate', '--json'],
    ['config', 'path', '--json'],
    ['setup', '--json'],
  ];
  for (const args of cases) {
    const r = await runCli(args, { env, cwd: ws });
    assert.equal(r.code, 0, `${args.join(' ')} → ${r.code}\n${r.stdout}\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${args.join(' ')} prints JSON`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, STACK_TRACE, `${args.join(' ')} has no stack trace`);
  }

  const models = JSON.parse((await runCli(['models', '--allowed', '--json'], { env, cwd: ws })).stdout).models;
  assert.equal(models.length, 14, 'no policy yet: every connected model is allowed');
  const setup = JSON.parse((await runCli(['setup', '--json'], { env, cwd: ws })).stdout);
  assert.equal(setup.onboarding.needed, true);
  const opencodeDefault = fixtureData('config.json').model ?? null;
  const effective = JSON.parse((await runCli(['config', 'show', '--effective', '--json'], { env, cwd: ws })).stdout);
  assert.equal(effective.config.defaultModel, null, `opc has no default yet; OpenCode default ${opencodeDefault} applies at run time`);
  const bad = await runCli(['config', 'set', 'defaultVariant', 'definitely-not-a-variant'], { env, cwd: ws });
  assert.ok([2, 4].includes(bad.code), 'clear error, not a crash');
  assert.doesNotMatch(`${bad.stdout}\n${bad.stderr}`, STACK_TRACE);
  assert.equal(fs.existsSync(path.join(env.OPC_DATA_DIR, 'config.json')), false, 'failed edits write nothing');
});
