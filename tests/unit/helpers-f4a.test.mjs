import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, testEnv, makeWorkspace, FIXTURE_MODELS, writeGlobalConfig, writeWorkspaceConfig,
  promptModels, requestsTo, waitFor, parseFrontmatter,
} from '../helpers.mjs';

test('FIXTURE_MODELS exist in the provider fixtures', () => {
  const dir = path.join(REPO_ROOT, 'tests', 'fixtures', 'data');
  const text = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const full of Object.values(FIXTURE_MODELS)) {
    const [provider, ...rest] = full.split('/');
    assert.ok(text.includes(provider), `provider ${provider} missing from fixtures`);
    assert.ok(text.includes(rest.join('/')), `model ${rest.join('/')} missing from fixtures`);
  }
});

test('writeGlobalConfig (F1) writes config.json with mode 600 and returns the path', (t) => {
  const env = testEnv(t);
  const file = writeGlobalConfig(env, { delegation: { auto: true } });
  assert.equal(file, path.join(env.OPC_DATA_DIR, 'config.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { delegation: { auto: true } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeWorkspaceConfig writes .opc.json at the workspace root', (t) => {
  const ws = makeWorkspace(t);
  const file = writeWorkspaceConfig(ws, { delegation: { auto: false } });
  assert.equal(file, path.join(ws, '.opc.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { delegation: { auto: false } });
});

test('promptModels and requestsTo read the fake state', (t) => {
  const env = testEnv(t);
  fs.writeFileSync(env.FAKE_OPENCODE_STATE, JSON.stringify({
    boots: [],
    requests: [
      { method: 'POST', path: '/api/session', body: {} },
      { method: 'POST', path: '/api/session/ses_1/prompt', body: { text: 'x' } },
      { method: 'POST', path: '/api/session/ses_1/interrupt', body: null },
    ],
    prompts: [{ sessionID: 'ses_1', model: { providerID: 'p', id: 'a/b' } }],
  }));
  assert.deepEqual(promptModels(env), ['p/a/b']);
  assert.equal(requestsTo(env, 'POST', /\/interrupt$/).length, 1);
  assert.equal(requestsTo(env, 'POST', '/api/session').length, 1);
});

test('waitFor (F0) resolves with the first truthy value and rejects on timeout', async () => {
  let n = 0;
  assert.equal(await waitFor(() => (++n >= 3 ? 'ready' : null), { timeoutMs: 1000, intervalMs: 5 }), 'ready');
  await assert.rejects(waitFor(() => null, { timeoutMs: 50, intervalMs: 10 }), /waitFor timed out/);
});

test('parseFrontmatter splits simple YAML frontmatter and body', () => {
  const { data, body } = parseFrontmatter('---\nname: opc-worker\ntools: Bash\n---\n\n# Body\n');
  assert.deepEqual(data, { name: 'opc-worker', tools: 'Bash' });
  assert.equal(body, '\n# Body\n');
  assert.throws(() => parseFrontmatter('no frontmatter'), /missing frontmatter/);
});
