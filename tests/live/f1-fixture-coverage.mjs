// F1 contract: shapes of GET /api/provider, /api/agent, /api/command, /api/skill on the real OpenCode 2 server vs the fake fixtures.
// Run: OPC_LIVE=1 node --test tests/live/f1-fixture-coverage.mjs   (prints key paths only, never values)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureData, makeTempDir, trackTempDir, trackEnv, trackWorkspace } from '../helpers.mjs';
import { resolveDataDir, resolveWorkspaceRoot, workspaceStateDir, ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { loadConfig } from '../../plugins/opc/scripts/lib/config.mjs';
import { ensureServer, clientFor } from '../../plugins/opc/scripts/lib/server.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

const LIVE = process.env.OPC_LIVE === '1';
// Levels whose keys are IDs (collapsed to "<map>") and free-form objects (not descended).
const MAP_PATHS = new Set(['$.all[].models', '$.default']);
const OPAQUE_PATHS = new Set(['$.all[].options', '$.all[].models.<map>.options', '$.all[].models.<map>.headers', '$.all[].models.<map>.variants', '$[].options']);

export function shapePaths(value, at = '$', out = new Set()) {
  if (OPAQUE_PATHS.has(at)) return out;
  if (Array.isArray(value)) {
    out.add(`${at}[]`);
    value.forEach((v) => shapePaths(v, `${at}[]`, out));
  } else if (value && typeof value === 'object') {
    if (MAP_PATHS.has(at)) {
      out.add(`${at}.<map>`);
      Object.values(value).forEach((v) => shapePaths(v, `${at}.<map>`, out));
    } else {
      for (const [k, v] of Object.entries(value)) {
        out.add(`${at}.${k}`);
        shapePaths(v, `${at}.${k}`, out);
      }
    }
  }
  return out;
}

test('live contract: fixtures cover every key path the real server returns', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f1c-data-'));
  const ws = trackTempDir(t, makeTempDir('opc-live-f1c-ws-'));
  trackWorkspace(t, ws);
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  const workspaceRoot = resolveWorkspaceRoot(ws);
  const stateDir = workspaceStateDir(resolveDataDir(env), workspaceRoot);
  ensurePrivateDir(stateDir);
  const ctx = { stateDir, workspaceRoot, config: loadConfig({ dataDir, workspaceRoot }).config, env };
  const client = clientFor(ctx, await ensureServer(ctx));
  const api = createApi(client);
  const pairs = [
    ['provider.json', await api.providers()],
    // Raw response: api.agents() returns the adapted opc shape, which the V2 fixture does not mirror.
    ['agent.json', await client.get('/api/agent', { retryOnServerDown: true })],
    ['command.json', await api.commands()],
    ['skill.json', await api.skills()],
  ];
  const divergences = [];
  for (const [file, real] of pairs) {
    const fake = shapePaths(fixtureData(file));
    const live = shapePaths(real);
    const missingInFake = [...live].filter((p) => !fake.has(p)).sort();
    const extraInFake = [...fake].filter((p) => !live.has(p)).sort();
    t.diagnostic(`${file}: missing in fake=${missingInFake.length} extra in fake=${extraInFake.length}`);
    missingInFake.forEach((p) => t.diagnostic(`  missing ${p}`));
    extraInFake.forEach((p) => t.diagnostic(`  extra   ${p} (optional field absent on this machine?)`));
    divergences.push(...missingInFake.map((p) => `${file} ${p}`));
  }
  assert.deepEqual(divergences, [], 'update tests/fixtures/data/*.json (and the report) for every key path the real server returns');
});
