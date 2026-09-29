#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCli, stopAllServers, jobsIn, makeTempDir, makeWorkspace, trackEnv, trackWorkspace } from '../helpers.mjs';
import { safeOutputText, PROMPT, REPORT } from './_f4a-lib.mjs';

const rawCandidates = process.env.OPC_LIVE_PROBE_MODELS?.trim();
if (!rawCandidates) {
  console.error('Uso: OPC_LIVE_PROBE_MODELS="provider/model,provider/model" OPC_LIVE_MODEL="provider/model" OPC_LIVE=1 node tests/live/probe-failing-model.mjs');
  process.exit(2);
}
if (process.env.OPC_LIVE !== '1' || !process.env.OPC_LIVE_MODEL?.trim()) {
  console.error('OPC_LIVE=1 e OPC_LIVE_MODEL são obrigatórios para sondar modelos.');
  process.exit(2);
}
const parsedLimit = Number(process.env.OPC_LIVE_PROBE_LIMIT ?? 8);
const limit = Number.isFinite(parsedLimit) ? Math.max(0, Math.floor(parsedLimit)) : 8;
const models = [...new Set(rawCandidates.split(',').map((model) => model.trim()).filter(Boolean))].slice(0, limit);
const root = makeTempDir('opc-live-f4a-probe-');
const ws = path.join(root, 'ws');
fs.mkdirSync(ws);
execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'opc-live'], { cwd: ws, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'opc-live@example.invalid'], { cwd: ws, stdio: 'ignore' });
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { mode: 0o700 });
const env = { ...process.env, OPC_DATA_DIR: dataDir };
delete env.OPC_SERVER_URL;
delete env.OPC_SERVER_PASSWORD;
let firstRecoverable = null;
const transcript = [];
try {
  for (const model of models) {
    const before = new Set(jobsIn(env, ws).map((job) => job.id));
    const result = await runCli(['ask', '--model', model, PROMPT], { env, cwd: ws, timeoutMs: 180_000 });
    const job = jobsIn(env, ws).find((candidate) => !before.has(candidate.id));
    const line = `${model}\t${job?.status ?? 'sem-job'}\t${job?.errorClass ?? '-'}\t${job?.errorType ?? '-'}`;
    transcript.push(line);
    if (job?.status === 'failed' && job.errorClass === 'recoverable' && !firstRecoverable) firstRecoverable = model;
  }
} finally {
  await stopAllServers(env, ws);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.appendFileSync(REPORT, safeOutputText(`### probe-failing-model\n\n\`\`\`\n${transcript.join('\n')}\nPrimeiro modelo recuperável: ${firstRecoverable ?? 'nenhum'}\n\`\`\`\n\n`, dataDir));
  for (const line of transcript) process.stdout.write(`${safeOutputText(line, dataDir)}\n`);
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(`${safeOutputText(`Primeiro modelo com falha recuperável: ${firstRecoverable ?? 'nenhum'}`, dataDir)}\n`);
