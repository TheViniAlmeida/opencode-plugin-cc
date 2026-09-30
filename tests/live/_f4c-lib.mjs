// Shared setup for the F4c live tests (not a test file). Only runs with OPC_LIVE=1.
// Routes come from the environment (OPC_LIVE_MODEL, _2, _3; optional _4 as the extra model and
// OPC_LIVE_JUDGE_MODEL), because the plan's opencode-go/* routes answer 402 (fatal) on the gateway
// used by the gate (plan adjustments after F4b, item 9).
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, makeWorkspace, runCli, trackEnv, trackTempDir, writeGlobalConfig, REPO_ROOT } from '../helpers.mjs';
import { appendSafeOutput, safeOutputText } from './_f3-lib.mjs';
import { FAST, SECOND, THIRD, DEFAULT_PROVIDER, SKIP } from './_f4a-lib.mjs';
import { loadConclaveAssets, buildMemberSchema, buildDebateSchema, buildSynthesisSchema } from '../../plugins/opc/scripts/lib/conclave.mjs';

export { SKIP };
export const PROVIDER = DEFAULT_PROVIDER;
export const REPORT = path.join(REPO_ROOT, 'docs/phases/F4c-live-output.md');
export const BASE_POOL = (process.env.OPC_LIVE_POOL ?? [FAST, SECOND, THIRD].join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
export const EXTRA = process.env.OPC_LIVE_MODEL_4?.trim() || null;
export const JUDGE = process.env.OPC_LIVE_JUDGE_MODEL?.trim() || THIRD;
export const LIVE_TIMEOUT_MS = 60 * 60 * 1000;
export const QUESTION = 'For a small Node.js CLI with zero runtime dependencies, should user configuration be stored as JSON or TOML? Consider parsing without dependencies, comments, and hand editing.';

// Mirrors the operator's world profile (spec §3.2): only the personal provider, no work models or agents.
export const WORLD_POLICY = {
  providers: { allow: [], deny: ['omniroute-work'] },
  models: { allow: [`${PROVIDER}/*`], deny: [] },
  agents: { allow: [], deny: ['work-*'] },
  tools: { deny: [] },
};

// F0 per-test cleanup stops env × cwd servers before removing cwd and dataDir (a t.after registered here would
// run after makeWorkspace's dir removal → ENOENT and a leaked server).
export function liveSetup(t, { git = true } = {}) {
  const cwd = makeWorkspace(t, { git, name: 'f4c-live' });
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f4c-data-'));
  fs.chmodSync(dataDir, 0o700);
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  delete env.OPC_SERVER_PASSWORD;
  delete env.CLAUDE_PLUGIN_DATA;
  writeGlobalConfig(env, { defaultProvider: PROVIDER, policy: WORLD_POLICY, conclave: { memberTimeoutSec: 600 } });
  return { env, cwd, dataDir };
}

export async function liveConclave(args, { env, cwd }) {
  const res = await runCli(['conclave', ...args], { env, cwd, timeoutMs: LIVE_TIMEOUT_MS });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { ...res, json };
}

export function failureDetails(pkg) {
  return (pkg?.failures ?? []).map((f) => [f.label, f.round, f.errorType, String(f.message ?? '').slice(0, 200)]);
}

export async function attempts(n, fn) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const started = Date.now();
    const detail = {};
    try {
      Object.assign(detail, await fn(i, detail));
      results.push({ run: i + 1, ok: true, seconds: Math.round((Date.now() - started) / 1000), detail });
    } catch (err) {
      const error = String(err?.message ?? err).slice(0, 2000);
      results.push({ run: i + 1, ok: false, seconds: Math.round((Date.now() - started) / 1000), detail: { ...detail, error } });
    }
  }
  return results;
}

export function schemas() {
  const assets = loadConclaveAssets();
  return {
    member: buildMemberSchema(assets.schemas.member),
    debate: (peerLabels) => buildDebateSchema(assets.schemas.member, peerLabels),
    synthesis: (labels) => buildSynthesisSchema(assets.schemas.synthesis, labels),
  };
}

export function familyWords(models) {
  const words = new Set([PROVIDER, 'omniroute', 'opencode-go']);
  for (const full of models) {
    const last = full.split('/').at(-1).toLowerCase();
    const lead = last.match(/^[a-z]+/)?.[0];
    if (lead && lead.length >= 3) words.add(lead);
  }
  return [...words];
}

// Sanitized transcript for docs/phases/F4c-live-output.md (provider id neutral, paths as <tmp>/~).
export function transcript(title, dataDir, results) {
  const lines = results.map((r) => `run ${r.run}: ${r.ok ? 'ok' : 'FAIL'} (${r.seconds}s) ${JSON.stringify(r.detail)}`);
  const text = `### ${title}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n`;
  appendSafeOutput(REPORT, safeOutputText(text, dataDir), dataDir);
}
