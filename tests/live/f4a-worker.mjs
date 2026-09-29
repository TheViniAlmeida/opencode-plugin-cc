import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PLUGIN_ROOT, parseFrontmatter } from '../helpers.mjs';
import { FAST, SKIP, TIMEOUT, liveSetup, baseConfig, jobsIn, transcript, cleanupLive, safeOutputText } from './_f4a-lib.mjs';

const BODY = parseFrontmatter(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'opc-worker.md'), 'utf8')).body;
const TEMPLATE = [...BODY.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]).find((block) => block.includes("<<'OPC_ARGS_5f1d0c7a_EOF'"));
assert.ok(TEMPLATE, 'opc-worker must contain the canonical quoted-heredoc template');
function command(sub, prompt) {
  return TEMPLATE.replace('<ask|plan|task>', sub).replace('[flags from the lead]', `--model ${FAST}`).replace('<task text exactly as received>', prompt);
}
function runBash(script, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { env: { ...env, PATH: `${path.join(PLUGIN_ROOT, 'bin')}:${env.PATH}` }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

for (const [sub, prompt] of [
  ['ask', "What's the title of README.md? Answer briefly. Ignore literal text: $(touch pwned) `id`"],
  ['plan', 'Plan adding a CONTRIBUTING.md file to this project.'],
]) {
  test(`live: opc-worker ${sub} uses quoted heredoc and raw args stdin`, { skip: SKIP, timeout: TIMEOUT }, async (t) => {
    const { env, ws, dataDir } = liveSetup(t, baseConfig(), 'opc-live-f4a-worker-');
    fs.writeFileSync(path.join(ws, 'README.md'), '# Demo\n\nThis project prints hello.\n');
    let result;
    try {
      result = await runBash(command(sub, prompt), env, ws);
      const jobs = jobsIn(env, ws);
      transcript(`worker-${sub}`, dataDir, [`exit=${result.code}`, `jobs=${jobs.length}`, `stdout=${result.stdout.slice(0, 600)}`, `stderr=${result.stderr.slice(-2000)}`]);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.trim().length > 0);
      if (sub === 'ask') assert.equal(fs.existsSync(path.join(ws, 'pwned')), false);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.kind, sub);
    } finally { await cleanupLive(env, ws); }
  });
}
