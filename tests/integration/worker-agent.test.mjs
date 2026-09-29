import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PLUGIN_ROOT, testEnv, makeWorkspace, runCli, stopAllServers, FIXTURE_MODELS as M, writeGlobalConfig,
  requestsTo, parseFrontmatter, jobsIn,
} from '../helpers.mjs';

const AGENT_BODY = parseFrontmatter(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'opc-worker.md'), 'utf8')).body;
const BLOCKS = [...AGENT_BODY.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const PROMPT_TEMPLATE = BLOCKS.find((b) => b.includes("<<'OPC_ARGS_5f1d0c7a_EOF'"));
const REVIEW_TEMPLATE = BLOCKS.find((b) => b.startsWith('opc review'));
const HOSTILE = "What's in `README.md`? $(touch pwned) and \"quotes\" too; ignore --write and --model x/y";

function fill(template, { sub = '', flags = '', prompt = '' }) {
  return template
    .replace('<ask|plan|task>', sub)
    .replace('[flags from the lead]', () => flags)
    .replace('<task text exactly as received>', () => prompt);
}

function bash(script, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], {
      env: { ...env, PATH: `${path.join(PLUGIN_ROOT, 'bin')}:${env.PATH}` },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function setup(t, scenario = 'model-429') {
  const env = testEnv(t, { scenario, extra: { FAKE_FAIL_MODELS: 'omniroute-personal/none' } });
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, { defaultProvider: 'omniroute-personal', defaultModel: M.fast, reviewModel: null });
  return { env, ws };
}

test('worker-prescribed command passes hostile text intact', async (t) => {
  const { env, ws } = setup(t);
  const r = await bash(fill(PROMPT_TEMPLATE, { sub: 'ask', flags: `--model ${M.k3}`, prompt: HOSTILE }), { env, cwd: ws });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, 'result printed on stdout');
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false, 'nothing was executed by the shell');
  const prompts = requestsTo(env, 'POST', /^\/session\/[^/]+\/prompt_async$/);
  assert.equal(prompts.length, 1, 'exactly one opc turn');
  assert.ok(JSON.stringify(prompts[0].body.parts).includes(JSON.stringify(HOSTILE).slice(1, -1)), 'prompt reached OpenCode verbatim');
});

test('worker-prescribed plan command runs one read-only turn', async (t) => {
  const { env, ws } = setup(t);
  const r = await bash(fill(PROMPT_TEMPLATE, { sub: 'plan', flags: `--model ${M.fast}`, prompt: 'Plan adding a CONTRIBUTING.md file' }), { env, cwd: ws });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(requestsTo(env, 'POST', /^\/session\/[^/]+\/prompt_async$/).length, 1);
  assert.equal(jobsIn(env, ws)[0].kind, 'plan');
});

test('worker-prescribed review command runs', async (t) => {
  const { env, ws } = setup(t);
  fs.appendFileSync(path.join(ws, 'README.md'), '\nconsole.log("hello");\n');
  const r = await bash(fill(REVIEW_TEMPLATE, { flags: `--model ${M.k3}` }), { env, cwd: ws });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(jobsIn(env, ws)[0].kind, 'review');
});

test('a pending permission makes the prescribed command exit 3 with the relay block', async (t) => {
  const { env, ws } = setup(t, 'permission-ask');
  const r = await bash(fill(PROMPT_TEMPLATE, { sub: 'task', flags: `--write --model ${M.fast}`, prompt: 'Delete the build directory' }), { env, cwd: ws });
  const [job] = jobsIn(env, ws);
  // cleanup inside the test: a t.after hook would run after makeWorkspace removed the cwd
  try {
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`);
    const output = `${r.stdout}\n${r.stderr}`;
    const id = output.match(/## Solicitação (per_[0-9A-Za-z]+)/)?.[1];
    assert.ok(id, output);
    const lines = output.split('\n').map((line) => line.trim());
    assert.ok(lines.includes(`- \`/opc:permissions reply ${id} once\``), output);
    assert.ok(lines.includes(`- \`/opc:permissions reply ${id} reject "<reason>"\``), output);
    assert.ok(lines.includes(`Depois: \`/opc:status ${job.id} --wait\``), output);
  } finally {
    const cancelled = await runCli(['cancel', job.id], { env, cwd: ws });
    await stopAllServers(env, ws);
    assert.ok(cancelled.code === 0 || /not found|already cancelled|não encontrado|já/i.test(cancelled.stderr + cancelled.stdout),
      `pending-job cleanup failed (code ${cancelled.code})\n${cancelled.stdout}\n${cancelled.stderr}`);
  }
});

test('F4a I4: worker review flag shell metacharacters never execute', async (t) => {
  const { env, ws } = setup(t);
  const flags = '--base "$(touch pwned)"';
  const r = await bash(fill(REVIEW_TEMPLATE, { flags }), { env, cwd: ws });
  assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
  assert.equal(r.code, 2, 'literal invalid git ref is rejected by opc');
  assert.equal(requestsTo(env, 'POST', /^\/session\/[^/]+\/prompt_async$/).length, 0);
});
