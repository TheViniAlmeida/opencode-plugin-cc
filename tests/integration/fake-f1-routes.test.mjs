import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, fixtureData, PLUGIN_ROOT } from '../helpers.mjs';
import { startFake, loadFixtureData } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';

async function boot(t, scenario = 'ok') {
  const port = await pickFreePort();
  const stateFile = path.join(makeTempDir(), 'fake-state.json');
  const fake = await startFake({ port, password: 'fake-password-123456', scenario, stateFile });
  t.after(() => fake.close());
  const client = createClient({ baseUrl: fake.url, password: 'fake-password-123456', directory: PLUGIN_ROOT });
  return { fake, api: createApi(client) };
}

test('fake serves /provider, /command, /skill and /agent from fixtures (raw, with keys)', async (t) => {
  const { api } = await boot(t);
  const providers = await api.providers();
  assert.deepEqual(providers.connected, fixtureData('provider.json').connected);
  assert.equal(providers.all.find((p) => p.id === 'omniroute-mvalmeida').key, 'sk-omr-FIXTURE-mvalmeida-0001', 'raw fixture keeps the key so redaction can be proven'); // scan-secrets:allow
  assert.deepEqual((await api.commands()).map((c) => c.name), fixtureData('command.json').map((c) => c.name));
  assert.deepEqual((await api.skills()).map((s) => s.name), ['brainstorm', 'release-notes']);
  assert.ok((await api.agents()).some((a) => a.name === 'work-deploy'));
});

test('scenario data overrides extend fixture responses (pinned-denied-model)', async (t) => {
  const { api } = await boot(t, 'pinned-denied-model');
  const agents = await api.agents();
  assert.deepEqual(agents.find((a) => a.name === 'pinned-reviewer').model, { providerID: 'omniroute-work', modelID: 'opencode-go/kimi-k3' });
  assert.ok((await api.commands()).some((c) => c.name === 'work-release'));
});

test('loadFixtureData: static override value and function override', () => {
  assert.deepEqual(loadFixtureData('skill.json', { scenario: { data: { 'skill.json': [] } } }), []);
  const extended = loadFixtureData('skill.json', { scenario: { data: { 'skill.json': (base) => base.slice(0, 1) } } });
  assert.equal(extended.length, 1);
});
