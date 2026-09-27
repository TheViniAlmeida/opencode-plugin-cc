import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, trackTempDir, fixtureData, PLUGIN_ROOT } from '../helpers.mjs';
import { startFake, loadFixtureData } from '../fixtures/fake-opencode.mjs';
import { pickFreePort } from '../../plugins/opc/scripts/lib/server.mjs';
import { createClient } from '../../plugins/opc/scripts/lib/http.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { redact } from '../../plugins/opc/scripts/lib/redact.mjs';

async function boot(t, scenario = 'ok') {
  const port = await pickFreePort();
  const stateFile = path.join(trackTempDir(t, makeTempDir()), 'fake-state.json');
  const fake = await startFake({ port, password: 'fake-password-123456', scenario, stateFile });
  t.after(() => fake.close());
  const client = createClient({ baseUrl: fake.url, password: 'fake-password-123456', directory: PLUGIN_ROOT });
  return { fake, api: createApi(client) };
}

test('fake serves /provider, /command, /skill and /agent from fixtures (raw, with keys)', async (t) => {
  const { api } = await boot(t);
  const providers = await api.providers();
  assert.deepEqual(providers.connected, fixtureData('provider.json').connected);
  const rawKey = providers.all.find((p) => p.id === 'omniroute-personal').key;
  assert.equal(rawKey, 'FAKE-PROVIDER-KEY-0001');
  const cliJson = JSON.stringify(redact(providers));
  assert.ok(!cliJson.includes(rawKey), 'provider key is redacted from CLI JSON by its property name');
  assert.deepEqual((await api.commands()).map((c) => c.name), fixtureData('command.json').map((c) => c.name));
  assert.deepEqual((await api.skills()).map((s) => s.name), ['brainstorm', 'release-notes']);
  assert.ok((await api.agents()).some((a) => a.name === 'work-deploy'));
});

test('provider fixture has unambiguous keys and CLI JSON redacts them', () => {
  const raw = requireProviderFixtureText();
  assert.equal(duplicateObjectKeys(raw).length, 0, 'JSON source has no duplicate object properties');
  assert.ok(!raw.includes('fixture-marker'), 'fixture marker must not leak into provider responses');
  const parsed = JSON.parse(raw);
  for (const provider of parsed.all) {
    assert.ok(!('fixture-marker' in provider));
    if ('key' in provider) {
      assert.equal(typeof provider.key, 'string');
      assert.ok(!/^(sk-|gh[pousr]_|xox[baprs]-)/i.test(provider.key), 'fixture key does not resemble a token');
    }
  }
  const cliJson = JSON.stringify(redact(parsed));
  for (const provider of parsed.all) {
    if (provider.key) assert.ok(!cliJson.includes(provider.key), 'provider key must not appear in CLI JSON');
  }
});

function requireProviderFixtureText() {
  return readFileSync(new URL('../fixtures/data/provider.json', import.meta.url), 'utf8');
}

function duplicateObjectKeys(source) {
  const duplicates = [];
  const stack = [];
  let string = false;
  let escaped = false;
  let token = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      else token += char;
      continue;
    }
    if (char === '"') {
      string = true;
      token = '';
      let j = i - 1;
      while (/\s/.test(source[j] ?? '')) j -= 1;
      if (source[j] === '{' || source[j] === ',') {
        const keyStart = i;
        let k = i + 1;
        let keyEscaped = false;
        for (; k < source.length; k += 1) {
          if (keyEscaped) keyEscaped = false;
          else if (source[k] === '\\') keyEscaped = true;
          else if (source[k] === '"') break;
        }
        let after = k + 1;
        while (/\s/.test(source[after] ?? '')) after += 1;
        if (source[after] === ':') {
          const key = JSON.parse(source.slice(keyStart, k + 1));
          const object = stack.at(-1);
          if (object?.keys.has(key)) duplicates.push(key);
          object?.keys.add(key);
        }
      }
      continue;
    }
    if (char === '{') stack.push({ keys: new Set() });
    else if (char === '}') stack.pop();
    else if (char === '[') stack.push(null);
    else if (char === ']') stack.pop();
  }
  return duplicates;
}

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
