import { join } from 'node:path';
import { appendSafeOutput, LIVE, LIVE_MODEL, MODELS, safeOutputText } from './_f3-lib.mjs';
import { makeTempDir, makeWorkspace, runCli, stopAllServers, trackEnv, trackTempDir, writeGlobalConfig, jobsIn, REPO_ROOT } from '../helpers.mjs';

export const REPORT = join(REPO_ROOT, 'docs/phases/F4a-live-output.md');

export { LIVE, safeOutputText, runCli, jobsIn };
export const FAST = LIVE_MODEL;
export const SECOND = MODELS.qwen;
export const THIRD = MODELS.kimi;
export const INVALID = FAST ? `${FAST.split('/')[0]}/does-not-exist-f4a` : '';
export const DEFAULT_PROVIDER = FAST?.split('/')[0] ?? '';
export const PROMPT = 'Reply with exactly the word PONG and nothing else. Do not use any tool.';
export const TIMEOUT = 600_000;
export const SKIP = !FAST
  ? 'OPC_LIVE_MODEL não definida; informe provider/model para executar os testes ao vivo.'
  : !LIVE && 'OPC_LIVE!=1';

export function liveSetup(t, cfg, prefix = 'opc-live-f4a-') {
  const dataDir = trackTempDir(t, makeTempDir(prefix));
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  delete env.OPC_SERVER_PASSWORD;
  const ws = makeWorkspace(t);
  writeGlobalConfig(env, cfg);
  return { env, ws, dataDir };
}

export function baseConfig({ ask = [FAST, SECOND], deny = [] } = {}) {
  return {
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: FAST,
    reviewModel: null,
    policy: { providers: { allow: [], deny: [] }, models: { allow: [], deny }, agents: { allow: [], deny: [] }, tools: { deny: [] }, sensitivePaths: ['*.env', '*.env.*', '**/.ssh/**', '*.pem', '*.key'], destructiveBash: [], approver: 'user', permissionTimeoutSec: 600 },
    routing: { tasks: { ask }, tiers: { light: [FAST], heavy: [THIRD] }, fallback: { enabled: true, maxAttempts: 3, maxProviderRetries: 3, maxRetryWaitSec: 60 } },
  };
}

export async function cleanupLive(env, ws) {
  return stopAllServers(env, ws);
}

export function transcript(title, dataDir, lines) {
  const text = `### ${title}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n`;
  appendSafeOutput(REPORT, safeOutputText(text, dataDir), dataDir);
}
