import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { main } from '../../plugins/opc/scripts/opc-companion.mjs';
import { redact } from '../../plugins/opc/scripts/lib/redact.mjs';
import { isSecretLikeSetting } from '../../plugins/opc/scripts/lib/config.mjs';
import { buildDraft, loadDraft, saveDraft, ONBOARDING_STEPS, runInitWizard, onboardingSummary } from '../../plugins/opc/scripts/lib/onboarding.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { tryAcquireLock } from '../../plugins/opc/scripts/lib/locks.mjs';
import { renderOnboarding } from '../../plugins/opc/scripts/lib/render.mjs';
import { makeTempDir, trackTempDir, captureStream, pipedStdin, scriptedTTY, fixtureData, writeGlobalConfig, FAKE_BIN_DIR, REPO_ROOT } from '../helpers.mjs';
import { createPrompter } from '../../plugins/opc/scripts/lib/tty.mjs';

const secretValues = { authToken: 'FAKE_AUTH_SENTINEL', api_key: 'FAKE_API_SENTINEL', apiKey: 'FAKE_CAMEL_SENTINEL' };
const safe = (output) => {
  for (const value of Object.values(secretValues)) assert.equal(output.includes(value), false, 'fake credential must be masked');
};
const complete = () => ({ ...buildDraft({ hasGlobal: false }), completed: ONBOARDING_STEPS.filter(s => s.id !== 'scope').map(s => s.id) });
function harness(t) {
  const originalSpawnSync = childProcess.spawnSync;
  const versionProbe = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (['opencode', 'npm'].includes(command) && args[0] === '--version') {
      return { status: 0, stdout: '1.18.32\n', stderr: '' };
    }
    return originalSpawnSync(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { versionProbe.mock.restore(); syncBuiltinESMExports(); });
  const dataDir = trackTempDir(t, makeTempDir('opc-final-data-'));
  const cwd = trackTempDir(t, makeTempDir('opc-final-ws-'));
  const env = { OPC_DATA_DIR: dataDir, OPC_SERVER_URL: 'http://127.0.0.1:1', PATH: `${FAKE_BIN_DIR}${path.delimiter}${process.env.PATH}` };
  const cli = async (argv, stdin = pipedStdin()) => {
    const stdout = captureStream(), stderr = captureStream();
    const code = await main(argv, { env, cwd, stdin, stdout, stderr });
    return { code, output: stdout.text() + stderr.text(), stdout: stdout.text() };
  };
  return { dataDir, cwd, cli, env };
}
function fakeFetch(t, { status = 200, failPath = null } = {}) {
  return t.mock.method(globalThis, 'fetch', async (url) => {
    const route = new URL(url).pathname;
    const data = route === '/global/health' ? { healthy: true, version: '1.18.32' }
      : route === '/provider' ? fixtureData('provider.json')
      : route === '/agent' ? fixtureData('agent.json')
      : route === '/config' ? { share: 'disabled' } : [];
    const code = route === failPath ? status : 200;
    return { ok: code < 400, status: code, text: async () => JSON.stringify(code >= 500 ? { error: 'falha simulada' } : data) };
  });
}

test('redact shares the setting predicate, including dotted draft keys and generic values', () => {
  for (const [key, value] of Object.entries(secretValues)) {
    assert.equal(isSecretLikeSetting(key), true);
    assert.equal(redact({ [key]: value })[key], '***');
    assert.equal(redact({ [`server.configOverride.${key}`]: value })[`server.configOverride.${key}`], '***');
    assert.equal(redact({ setting: `server.configOverride.${key}`, value }).value, '***');
  }
});

test('config show/get/set protect every secret-like value in JSON and text', async (t) => {
  const { dataDir, cli } = harness(t);
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, { server: { configOverride: secretValues } });
  for (const json of [[], ['--json']]) {
    for (const args of [['show'], ['show', '--effective'], ['get'], ['get', 'server.configOverride']]) {
      const r = await cli(['config', ...args, ...json]);
      assert.equal(r.code, 0, r.output); safe(r.output);
    }
    for (const [key, value] of Object.entries(secretValues)) {
      const setting = `server.configOverride.${key}`;
      const get = await cli(['config', 'get', setting, ...json]);
      assert.equal(get.code, 0); safe(get.output);
      const set = await cli(['config', 'set', setting, JSON.stringify(value), '--tty-confirm', ...json], scriptedTTY([setting]));
      assert.equal(set.code, 0, set.output); safe(set.output);
    }
  }
});

test('onboarding state and commit summaries protect nested and dotted secrets', async (t) => {
  fakeFetch(t);
  const { dataDir, cli } = harness(t);
  const applied = await cli(['setup', 'apply', JSON.stringify({ server: { configOverride: secretValues } }), '--json']);
  assert.equal(applied.code, 0, applied.output); safe(applied.output);
  const draft = complete();
  draft.values = { 'server.configOverride': secretValues, 'server.configOverride.authToken': secretValues.authToken };
  saveDraft(dataDir, draft);
  const summary = onboardingSummary({ hasGlobal: false, draft, catalog: buildCatalog(fixtureData('provider.json')), policy: {}, opencode: { installed: true }, npmAvailable: true });
  safe(JSON.stringify(summary));
  safe(renderOnboarding({ kind: 'state', onboarding: summary }));
  const state = await cli(['setup', '--json']);
  assert.equal(state.code, 0, state.output); safe(state.output);
  const committed = await cli(['setup', 'commit', '--json']);
  assert.equal(committed.code, 0, committed.output); safe(committed.output);
});

test('wizard summary and config init JSON mask fake secret-like settings from the existing config', async (t) => {
  fakeFetch(t);
  const { dataDir, cwd, cli } = harness(t);
  const catalog = buildCatalog(fixtureData('provider.json'));
  const provider = catalog.providers.find(p => p.modelCount === 7).id;
  const output = captureStream();
  const answers = ['1', '1', 'kimi-k3', '1', '1', '1', '1', '1', '', '1', '', '1', 'n', 'n', '', '', 'n', 'n'];
  const prompter = createPrompter({ input: scriptedTTY([...answers, 'n']), output });
  t.after(() => prompter.close());
  let summary = '';
  await runInitWizard({ prompter, catalog, agents: fixtureData('agent.json'), existing: { global: { defaultProvider: provider, server: { configOverride: secretValues } }, workspace: null }, hasGlobal: true, dataDir, workspaceRoot: cwd, log: s => { summary += s; } });
  assert.match(summary, /authToken/); safe(summary); safe(output.text());
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, { defaultProvider: provider, server: { configOverride: secretValues } });
  const result = await cli(['config', 'init', '--json'], scriptedTTY([...answers, 's']));
  assert.equal(result.code, 0, result.output); safe(result.output);
});

test('loadDraft rejects malformed structure and setup apply restarts cleanly', async (t) => {
  fakeFetch(t);
  const { dataDir, cli } = harness(t);
  const valid = buildDraft({ hasGlobal: false });
  const invalid = [
    ...Object.keys(valid).map(key => { const d = { ...valid }; delete d[key]; return d; }),
    { ...valid, schemaVersion: 99 }, { ...valid, mode: 'unknown' }, { ...valid, scope: 'other' },
    { ...valid, scope: 'workspace' }, { ...valid, completed: {} }, { ...valid, completed: [42] },
    { ...valid, completed: ['unknown'] }, { ...valid, completed: ['aliases', 'aliases'] },
    { ...valid, values: [] }, { ...valid, values: { defaultModel: 42 } },
    { ...valid, values: { unknown: true } }, { ...valid, createdAt: false }, { ...valid, updatedAt: 'not-a-date' }, { ...valid, createdAt: '1' },
  ];
  for (const draft of invalid) {
    saveDraft(dataDir, draft);
    assert.equal(loadDraft(dataDir), null, 'invalid draft must be discarded');
  }
  const result = await cli(['setup', 'apply', '{"defaultVariant":null}', '--json']);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(loadDraft(dataDir).completed, ['defaultVariant']);
});

test('setup commit refuses incomplete applicable steps before contacting a server and retains draft', async (t) => {
  const fetchMock = fakeFetch(t, { status: 503, failPath: '/global/health' });
  const { dataDir, cli } = harness(t);
  const draft = { ...buildDraft({ hasGlobal: false }), completed: ['defaultVariant'], values: { defaultVariant: null } };
  saveDraft(dataDir, draft);
  const result = await cli(['setup', 'commit', '--json']);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /etapas.*pendentes/i);
  for (const step of ['defaultProvider', 'allowedModels', 'allowedAgents', 'approver']) assert.ok(result.output.includes(step));
  assert.deepEqual(loadDraft(dataDir), draft);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});

test('reconfigure commit requires only applicable workspace steps', async (t) => {
  fakeFetch(t);
  const { dataDir, cwd, cli } = harness(t);
  writeGlobalConfig({ OPC_DATA_DIR: dataDir }, {});
  const partial = { scope: 'workspace', defaultProvider: null, defaultModel: null, reviewModel: null,
    defaultVariant: null, project: { goal: 'test workspace' }, aliases: {} };
  const applied = await cli(['setup', 'apply', JSON.stringify(partial), '--json']);
  assert.equal(applied.code, 0, applied.output);
  const committed = await cli(['setup', 'commit', '--json']);
  assert.equal(committed.code, 0, committed.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.opc.json'), 'utf8')).project.goal, 'test workspace');
});

test('concurrent setup commits serialize bootstrap under the config lock', async (t) => {
  fakeFetch(t);
  const { dataDir, cli } = harness(t);
  saveDraft(dataDir, { ...complete(), values: { 'policy.approver': 'claude' } });
  const release = tryAcquireLock(path.join(dataDir, 'config.lock'), { purpose: 'test-bootstrap-race' });
  const attempts = [cli(['setup', 'commit', '--json']), cli(['setup', 'commit', '--json'])];
  let writtenWhileLocked;
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    writtenWhileLocked = fs.existsSync(path.join(dataDir, 'config.json'));
  } finally { release(); }
  const results = await Promise.all(attempts);
  assert.equal(writtenWhileLocked, false, 'config read/decision/write must wait for lock');
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.code === 2 || r.code === 4).length, 1);
  const winner = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  saveDraft(dataDir, { ...complete(), values: { 'policy.approver': 'user' } });
  const retry = await cli(['setup', 'commit', '--json']);
  assert.equal(retry.code, 4, retry.output);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), winner);
  assert.ok(loadDraft(dataDir));
});

for (const [name, argv, failPath] of [
  ['providers', ['providers', '--json'], '/provider'], ['models', ['models', '--json'], '/provider'],
  ['agents', ['agents', '--json'], '/agent'], ['catalog commands', ['catalog', 'commands', '--json'], '/command'],
  ['catalog skills', ['catalog', 'skills', '--json'], '/skill'], ['config validate', ['config', 'validate', '--json'], '/provider'],
  ['config set', ['config', 'set', 'defaultProvider', 'example', '--json'], '/provider'],
  ['setup models', ['setup', 'models', '--provider', 'example', '--json'], '/provider'],
  ['setup apply', ['setup', 'apply', '{}', '--json'], '/provider'], ['setup commit', ['setup', 'commit', '--json'], '/provider'],
  ['setup diagnose', ['setup', '--json'], '/global/health'],
  ['setup state', ['setup', '--json'], '/provider'],
]) test(`F1 ${name}: HTTP 503 exits 5`, async (t) => {
  fakeFetch(t, { status: 503, failPath });
  const { dataDir, cli } = harness(t);
  saveDraft(dataDir, complete());
  const result = await cli(argv);
  assert.match(result.output, /SERVER_ERROR/);
  assert.equal(result.code, 5, result.output);
});

test('setup usage errors are PT-BR and unknown provider echo is bounded', async (t) => {
  fakeFetch(t);
  const { cli } = harness(t);
  for (const args of [['models'], ['models', '--provider', 'example', '--top', '0'], ['apply'], ['commit', 'extra'], ['commit']]) {
    const r = await cli(['setup', ...args]);
    assert.equal(r.code, 2); assert.doesNotMatch(r.output, /usage:|must be|no onboarding draft/);
    assert.match(r.output, /uso:|deve ser|rascunho/i);
  }
  const provider = 'unknown-provider-'.repeat(30);
  const result = await cli(['setup', 'models', '--provider', provider]);
  assert.equal(result.code, 2); assert.match(result.output, /provedor.*não está conectado/);
  assert.equal(result.output.includes(provider), false);
  assert.ok(result.output.length < 250);
});

test('public sources use neutral provider IDs and live models have no default', () => {
  const privateId = ['mval', 'meida'].join('');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'superpowers') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else assert.equal(fs.readFileSync(file, 'utf8').includes(privateId), false, path.relative(REPO_ROOT, file));
    }
  }
  for (const dir of ['plugins', 'tests', 'docs']) walk(path.join(REPO_ROOT, dir));
  for (const file of ['f1-discovery.mjs', 'probe-permission-precedence.mjs']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'tests/live', file), 'utf8');
    assert.doesNotMatch(source, /OPC_LIVE_MODEL\s*\?\?/);
    assert.match(source, /OPC_LIVE_MODEL[^\n]*(não definid|ausente)/);
  }
});

test('live fixture coverage uses the verified helper cleanup, including failure retention', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'tests/live/f1-fixture-coverage.mjs'), 'utf8');
  for (const helper of ['makeTempDir', 'trackTempDir', 'trackEnv', 'trackWorkspace']) assert.ok(source.includes(`${helper}(`), helper);
  assert.doesNotMatch(source, /mkdtempSync|rmSync|stopAllServers|t\.after/);
});

test('phase report records the already committed documentation', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'docs/phases/F1-report.md'), 'utf8');
  assert.doesNotMatch(source, /COMMIT_BLOCKED/);
  assert.match(source, /efd8981/);
});
