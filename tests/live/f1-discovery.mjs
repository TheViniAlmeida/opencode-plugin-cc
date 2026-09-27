// F1 live checks (spec §13.3 F1 "Aceite (ao vivo)"). Run: OPC_LIVE=1 node --test tests/live/f1-discovery.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir, trackTempDir, trackEnv, trackWorkspace, runCli, REPO_ROOT } from '../helpers.mjs';
import { createContext, connectApi } from '../../plugins/opc/scripts/lib/context.mjs';

const source = fs.readFileSync(new URL(import.meta.url), 'utf8');

test('F1 live regression: scanner receives the test OPC_DATA_DIR', () => {
  assert.match(source, /spawnSync\(process\.execPath, \[path\.join\(REPO_ROOT, 'scripts', 'scan-secrets\.mjs'\), file\], \{[^}]*env: \{ \.\.\.process\.env, OPC_DATA_DIR: dataDir \}/s);
});

test('F1 live regression: raw JSON output file is private', () => {
  assert.ok(source.includes("fs.writeFileSync(file, outputs.join('\\n'), { mode: 0o600 });"));
});

test('F1 live regression: agents compares the CLI subset and raw server API sets', () => {
  assert.doesNotMatch(source, /for \(const name of ours\)/);
  assert.doesNotMatch(source, /json\(\['agents', '--json'\]\)/);
  assert.match(source, /connectApi\(ctx\)/);
  assert.match(source, /api\.agents\(\)/);
  assert.match(source, /agents', '--verbose', '--json'/);
  assert.match(source, /opencodeNames/);
  assert.match(source, /serverAgents/);
  assert.match(source, /new Set\(/);
});

test('F1 live regression: agent assertion diagnostics do not expose full names', () => {
  const block = source.match(/test\('live: \/opc:agents[\s\S]*?\n\}\);/);
  assert.ok(block, 'live agents test exists');
  assert.doesNotMatch(block[0], /agents?: \$\{[^}]*\.join\(/);
  assert.match(block[0], /count|length/);
});

const LIVE = process.env.OPC_LIVE === '1';
const MODEL = process.env.OPC_LIVE_MODEL ?? 'omniroute-mvalmeida/opencode-go/kimi-k3';
const WORLD_PROVIDER = 'omniroute-work';
const WORLD = { policy: { providers: { allow: [], deny: [WORLD_PROVIDER] }, agents: { allow: [], deny: ['work-*'] } } };

function liveEnv(t) {
  const dataDir = trackTempDir(t, makeTempDir('opc-live-f1-data-'));
  const ws = trackTempDir(t, makeTempDir('opc-live-f1-ws-'));
  trackWorkspace(t, ws);
  fs.writeFileSync(path.join(ws, 'README.md'), '# live f1\n');
  const env = trackEnv(t, { ...process.env, OPC_DATA_DIR: dataDir });
  delete env.OPC_SERVER_URL;
  const cli = async (args, opts = {}) => runCli(args, { env, cwd: ws, timeoutMs: 180000, ...opts });
  const json = async (args) => {
    const r = await cli(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return { env, ws, dataDir, cli, json };
}

function opencode(args, { cwd }) {
  const r = spawnSync('opencode', args, { cwd, encoding: 'utf8', timeout: 180000, shell: false });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('live: /opc:models --all matches `opencode models` per provider', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { ws, json } = liveEnv(t);
  const { providers } = await json(['providers', '--json']);
  assert.ok(providers.length > 0, 'at least one connected provider');
  let listing = opencode(['models'], { cwd: ws });
  assert.equal(listing.code, 0, listing.stderr);
  const theirsAll = new Set(listing.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l)));
  for (const p of providers) {
    const perProvider = opencode(['models', p.id], { cwd: ws });
    const theirs = perProvider.code === 0
      ? perProvider.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${p.id}/`))
      : [...theirsAll].filter((l) => l.startsWith(`${p.id}/`));
    const ours = (await json(['models', p.id, '--all', '--json'])).models.map((m) => m.full);
    t.diagnostic(`${p.id}: opc=${ours.length} opencode=${theirs.length} (per-provider arg ${perProvider.code === 0 ? 'ok' : 'unsupported, used full list'})`);
    assert.deepEqual([...ours].sort(), [...new Set(theirs)].sort(), `models of ${p.id}`);
  }
});

test('live: /opc:agents matches the server API and includes the CLI agent subset', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { ws, env, json } = liveEnv(t);
  const listing = opencode(['agent', 'list'], { cwd: ws });
  assert.equal(listing.code, 0, listing.stderr);
  const opencodeNames = new Set(listing.stdout.split('\n').map((line) => line.trim()).filter((line) => /^[\w-]+(?:\s|$)/.test(line)).map((line) => line.split(/\s+/)[0]));
  const ctx = await createContext({ argv: [], env, cwd: ws, createDataDir: true });
  const { api } = await connectApi(ctx);
  const serverAgents = await api.agents();
  const listed = (await json(['agents', '--verbose', '--json'])).agents;
  const listedByName = new Map(listed.map((agent) => [agent.name, agent]));
  const rawByName = new Map(serverAgents.map((agent) => [agent.name, agent]));
  const missingFromOpc = [...opencodeNames].filter((name) => !listedByName.has(name));
  const namesMatch = listedByName.size === rawByName.size && [...rawByName.keys()].every((name) => listedByName.has(name));
  const modesMatch = [...rawByName].every(([name, agent]) => listedByName.get(name)?.mode === agent.mode);
  const examples = (names) => names.slice(0, 3).map((name) => `${String(name).slice(0, 32)}${String(name).length > 32 ? '…' : ''}`).join(', ');
  assert.equal(missingFromOpc.length, 0, `CLI agents missing from opc: count=${missingFromOpc.length}${missingFromOpc.length ? ` examples=${examples(missingFromOpc)}` : ''}`);
  assert.ok(namesMatch, `/opc:agents names differ from server API: opc=${listedByName.size} api=${rawByName.size}`);
  assert.ok(modesMatch, `/opc:agents modes differ from server API: opc=${listedByName.size} api=${rawByName.size}`);
  t.diagnostic(`agents: opc=${listedByName.size} api=${rawByName.size} cli=${opencodeNames.size}`);
});

test('live: world policy hides omniroute-work/* and work-* and refuses explicit use', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { dataDir, cli, json } = liveEnv(t);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(WORLD), { mode: 0o600 });
  const models = (await json(['models', '--allowed', '--json'])).models;
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.providerID !== WORLD_PROVIDER));
  const agents = (await json(['agents', '--allowed', '--verbose', '--json'])).agents;
  assert.ok(agents.every((a) => !a.name.startsWith('work-')));
  const everyModel = (await json(['models', '--all', '--json'])).models;
  const eqModel = everyModel.find((m) => m.providerID === WORLD_PROVIDER && m.connected);
  if (eqModel) {
    const r = await cli(['config', 'set', 'defaultModel', eqModel.full]);
    assert.equal(r.code, 4, r.stderr);
  } else {
    t.diagnostic(`N/A: provider ${WORLD_PROVIDER} not connected on this machine`);
  }
  const eqAgent = (await json(['agents', '--verbose', '--json'])).agents.find((a) => a.name.startsWith('work-'));
  if (eqAgent) {
    const r = await cli(['config', 'set', 'defaultAgent', eqAgent.name]);
    assert.equal(r.code, 4, r.stderr);
  } else {
    t.diagnostic('N/A: no work-* agent configured in OpenCode on this machine');
  }
});

test('live: valid variant of the phase model is accepted; invalid one refused', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { cli, json } = liveEnv(t);
  const provider = MODEL.split('/')[0];
  const entry = (await json(['models', provider, '--verbose', '--json'])).models.find((m) => m.full === MODEL);
  assert.ok(entry, `${MODEL} is in the catalog`);
  assert.equal((await cli(['config', 'set', 'defaultModel', MODEL])).code, 0);
  if (!entry.variants.length) {
    t.skip(`N/A: ${MODEL} has no variants`);
    return;
  }
  const ok = await cli(['config', 'set', 'defaultVariant', entry.variants[0]]);
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await cli(['config', 'set', 'defaultVariant', 'definitely-not-a-variant']);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout + bad.stderr, /UNKNOWN_VARIANT/);
});

test('live: companion side of the guided onboarding writes the expected config', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { dataDir, cli, json } = liveEnv(t);
  const state = (await json(['setup', '--json'])).onboarding;
  assert.equal(state.mode, 'bootstrap');
  const provider = MODEL.split('/')[0];
  const apply = async (payload) => {
    const r = await cli(['setup', 'apply', '--json', '--stdin'], { stdin: JSON.stringify(payload) });
    assert.equal(r.code, 0, `${JSON.stringify(payload)}: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  await apply({ defaultProvider: provider });
  await apply({ defaultModel: MODEL });
  await apply({ reviewModel: null, stopGate: { model: null } });
  await apply({ defaultVariant: null });
  await apply({ policy: { models: { allow: [`${provider}/*`] }, providers: { deny: [WORLD_PROVIDER] } } });
  await apply({ policy: { agents: { allow: [], deny: ['work-*'] } } });
  await apply({ policy: { approver: 'user' } });
  await apply({ stopGate: { enabled: false }, delegation: { auto: false } });
  await apply({ project: { goal: 'opc live F1', scope: [], taskTypes: ['ask', 'review'] } });
  const last = await apply({ aliases: { k3: MODEL } });
  assert.equal(last.nextStep, null);
  const commit = await cli(['setup', 'commit', '--json']);
  assert.equal(commit.code, 0, commit.stdout + commit.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.defaultModel, MODEL);
  assert.deepEqual(cfg.policy.providers.deny, [WORLD_PROVIDER]);
  assert.equal(cfg.aliases.k3, MODEL);
  assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
});

test('live: JSON output of providers/models never carries provider credentials', { skip: !LIVE && 'OPC_LIVE!=1' }, async (t) => {
  const { cli, dataDir } = liveEnv(t);
  const outputs = [];
  for (const args of [['providers', '--all', '--json'], ['models', '--all', '--verbose', '--json'], ['setup', '--json']]) {
    const r = await cli(args);
    assert.equal(r.code, 0, r.stderr);
    outputs.push(r.stdout);
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          assert.ok(!['key', 'apiKey', 'headers', 'options'].includes(k) || val === '***', `${args.join(' ')} exposes "${k}"`);
          walk(val);
        }
      }
    };
    walk(JSON.parse(r.stdout));
  }
  const file = path.join(dataDir, 'live-f1-outputs.json');
  fs.writeFileSync(file, outputs.join('\n'), { mode: 0o600 });
  const scan = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs'), file], {
    encoding: 'utf8',
    env: { ...process.env, OPC_DATA_DIR: dataDir },
  });
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
});
