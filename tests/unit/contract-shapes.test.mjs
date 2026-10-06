import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { CONFIG_USED_FIELDS, EVENT_TYPES, PROBES, diffShapes, evidenceVerdict, lookup, mergeVerdict, shapeOf, toolAttempted } from '../fixtures/contract-shapes.mjs';
import { fixtureData } from '../helpers.mjs';

const agentItem = {
  name: 'synthetic-agent', mode: 'primary', permission: { model: { enabled: 'deny' } },
  options: { temperature: 0.5 }, model: 'synthetic/model', prompt: 'synthetic prompt',
  description: 'synthetic description', hidden: false, color: '#123456', steps: 10,
  variant: 'default', temperature: 0.5,
};

test('V2 fixtures provide separate provider, model and agent lists without settings', () => {
  const provider = fixtureData('provider.json');
  const models = fixtureData('model.json');
  assert.ok(provider.some((item) => item.id && item.name && item.activation));
  assert.ok(models.some((item) => item.id && item.modelID && item.providerID && Array.isArray(item.variants)));
  assert.ok(provider.every((item) => !Object.hasOwn(item, 'settings')));
  assert.ok(models.every((item) => !Object.hasOwn(item, 'settings')));
  const agents = fixtureData('agent.json');
  assert.ok(agents.some((agent) => agent.id === 'build' && Array.isArray(agent.permissions)));
});

test('agent array snapshots preserve all 12 known properties regardless of size', () => {
  assert.deepEqual(shapeOf([agentItem], 'agent'), [{
    name: 'string', mode: 'string', permission: { '*': { '*': 'string' } },
    options: { temperature: 'number' }, model: 'string', prompt: 'string',
    description: 'string', hidden: 'boolean', color: 'string', steps: 'number',
    variant: 'string', temperature: 'number',
  }]);
  const manyKeys = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, i]));
  assert.deepEqual(shapeOf(manyKeys), Object.fromEntries(Object.keys(manyKeys).map((key) => [key, 'number'])));
});

test('agent array snapshots collapse unknown names recursively and permission maps always', () => {
  assert.deepEqual(shapeOf([{
    name: 'alice', alice: true, options: { alice: { enabled: true } },
    permission: { model: { enabled: 'deny' } },
  }], 'agent'), [{
    name: 'string', '*': 'boolean', options: { '*': { enabled: 'boolean' } },
    permission: { '*': { '*': 'string' } },
  }]);
});

test('F1 endpoint snapshots never expose provider, model, command, or skill names', () => {
  const value = {
    all: [{
      id: 'synthetic-provider', name: 'Synthetic Provider',
      models: { 'synthetic-provider/synthetic-model': { id: 'synthetic-model', name: 'Synthetic Model', limit: {} } },
      options: { syntheticProviderOption: true },
    }],
    default: 'synthetic-provider',
  };
  const snapshots = [
    shapeOf(value, 'provider'),
    shapeOf({ 'synthetic-command': { name: 'synthetic-command', description: 'synthetic command' } }, 'command'),
    shapeOf({ 'synthetic-skill': { name: 'synthetic-skill', description: 'synthetic skill' } }, 'skill'),
    shapeOf({ 'synthetic-agent': { name: 'synthetic-agent', mode: 'primary' } }, 'agent'),
  ];
  const serialized = JSON.stringify(snapshots);
  for (const personal of ['synthetic-provider', 'Synthetic Provider', 'synthetic-model', 'Synthetic Model', 'syntheticProviderOption', 'synthetic-command', 'synthetic-skill', 'synthetic-agent']) {
    assert.equal(serialized.includes(personal), false, personal);
  }
});

test('live collection prunes real and fake agent responses identically before diffing', async () => {
  const source = fs.readFileSync(path.resolve('tests/live/contract.mjs'), 'utf8');
  const collectSource = source.slice(source.indexOf('async function collect('), source.indexOf('\nconst base ='));
  const collect = vm.runInNewContext(`(${collectSource})`, {
    PROBES, EVENT_TYPES, shapeOf, performance,
    EventHub: class {
      onAny(callback) { this.callback = callback; }
      async start() { for (const type of EVENT_TYPES) this.callback({ id: 'synthetic', type, properties: {} }); }
      stop() {}
    },
  });
  const client = (unknown) => ({ request: async (_method, endpoint) => endpoint === '/agent'
    ? [{ ...agentItem, options: { [unknown]: true } }] : {} });
  const real = await collect(client('alice'), {});
  const fake = await collect(client('bob'), {});
  const probe = PROBES.find((entry) => entry.name === 'agent');
  assert.deepEqual(diffShapes(real.agent, fake.agent, probe.used, probe.optionalUsed), []);
  assert.deepEqual(real.agent, shapeOf([{ ...agentItem, options: { alice: true } }], 'agent'));
  assert.deepEqual(fake.agent, real.agent);
  assert.equal(lookup(real.agent, '[].name'), 'string');
  assert.deepEqual(lookup(fake.agent, '[].options'), { '*': 'boolean' });
});

test('shapeOf records types, first array element and collapses user-data maps', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', n: null, l: [{ k: true }] }), { a: 'string', b: 'number', l: [{ k: 'boolean' }], n: 'null' });
  assert.deepEqual(shapeOf([]), ['empty']);
  assert.deepEqual(shapeOf({ mcp: { gitlab: { type: 'local' }, other: {} } }, 'config'), { mcp: { '*': { type: 'string' } } });
  assert.deepEqual(shapeOf({}, 'session.status'), { '*': 'empty' });
});

test('config snapshots retain only used fields and redact user-controlled keys at every depth', () => {
  const config = {
    autoshare: true, share: 'auto', model: 'private/model', small_model: 'private/small',
    mcp: { 'hive-alice': { type: 'local' } },
    agent: {
      'alice-agent': { model: 'private/model' },
      bob: { permission: { bash: { alice: 'deny', '/home/*/bin*': 'allow', '$HOME/.*': 'deny' } } },
    },
    provider: { 'omniroute-alice': { models: { 'opencode-go/alice-model': { name: 'private value' } } } },
    permission: { nested: { '/home/alice/bin*': 'deny' } },
    keybinds: { alice: 'private value' },
    unrelated: { alice: 'private value' },
  };
  const shape = shapeOf(config, 'config');
  const serialized = JSON.stringify(shape);
  for (const personal of ['alice', 'bob', '/home', 'HOME', 'hive', 'omniroute', 'keybinds', 'private value']) assert.equal(serialized.includes(personal), false, personal);
  for (const field of ['autoshare', 'share', 'agent', 'permission', 'mcp', 'provider']) assert.ok(Object.hasOwn(shape, field), `${field} missing from shape`);
  assert.deepEqual(Object.keys(shape).sort(), CONFIG_USED_FIELDS.filter((field) => Object.hasOwn(config, field)).sort());
  for (const field of CONFIG_USED_FIELDS) assert.ok(Object.hasOwn(shape, field), `${field} missing from shape`);
  assert.equal(shape.share, 'string');
  assert.deepEqual(shape.mcp, { '*': { type: 'string' } });
});

test('config snapshots include every consumed top-level field including legacy autoshare', () => {
  const fields = ['autoshare', 'share', 'model', 'small_model', 'mcp', 'agent', 'provider', 'permission'];
  for (const field of fields) assert.ok(CONFIG_USED_FIELDS.includes(field), field);
  assert.deepEqual(shapeOf({ autoshare: true, keybinds: {} }, 'config'), { autoshare: 'boolean' });
});

test('config snapshots merge unknown keys recursively while retaining known properties', () => {
  const shape = shapeOf({ agent: {
    'alice-agent': { options: { alice: { enabled: true, bob: { temperature: 0.5 } } } },
    bob: { options: { bob: { timeout: 10, alice: { top_p: 0.9 } } }, description: 'private value' },
  } }, 'config');
  assert.deepEqual(shape, { agent: { '*': {
    description: 'string',
    options: { '*': { enabled: 'boolean', timeout: 'number', '*': { temperature: 'number', top_p: 'number' } } },
  } } });
  assert.deepEqual(shapeOf({ mcp: { alice: { command: [{ alice: { enabled: true } }] } } }, 'config'), {
    mcp: { '*': { command: [{ '*': { enabled: 'boolean' } }] } },
  });
});

test('config permission keys always collapse even when they match known property names', () => {
  for (const permission of [
    { bash: { alice: 'deny' } },
    { bash: { '/home/*/bin*': 'allow', '$HOME/.*': 'deny' } },
    { model: { enabled: 'deny', options: { timeout: 'allow' } } },
  ]) {
    const expected = Object.hasOwn(permission, 'model')
      ? { '*': { '*': 'mixed' } }
      : { '*': { '*': 'string' } };
    assert.deepEqual(shapeOf({ permission }, 'config'), { permission: expected });
    assert.deepEqual(shapeOf({ agent: { bob: { permission } } }, 'config'), {
      agent: { '*': { permission: expected } },
    });
  }
});

test('config snapshots preserve allowlisted properties regardless of object size', () => {
  const properties = ['enabled', 'type', 'command', 'url', 'environment', 'headers', 'timeout',
    'model', 'mode', 'prompt', 'description', 'temperature', 'top_p', 'tools', 'disable',
    'hidden', 'permission', 'options', 'models', 'name', 'npm', 'api', 'variant', 'variants', 'steps', 'color'];
  const config = { agent: { bob: Object.fromEntries(properties.map((key) => [key, 'private value'])) } };
  assert.deepEqual(shapeOf(config, 'config'), {
    agent: { '*': Object.fromEntries(properties.map((key) => [key, 'string'])) },
  });
});

test('lookup walks dotted paths with [] for array elements', () => {
  const shape = shapeOf([{ name: 'build', permission: [{ action: 'allow' }] }]);
  assert.equal(lookup(shape, '[].name'), 'string');
  assert.deepEqual(lookup(shape, '[].permission'), [{ '*': 'string' }]);
  assert.equal(lookup(shape, '[].missing'), undefined);
  assert.equal(lookup({ a: 'string' }, '[].a'), undefined);
});

test('diffShapes reports missing and different used fields only', () => {
  const real = shapeOf({ healthy: true, version: '1', extra: 1 });
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: true, version: '1' }), ['healthy', 'version']), []);
  assert.deepEqual(diffShapes(real, shapeOf({ healthy: 'yes', version: '1' }), ['healthy']), [{ field: 'healthy', real: '"boolean"', fake: '"string"' }]);
  assert.equal(diffShapes(shapeOf({}), shapeOf({ version: '1' }), ['version'])[0].real, 'ausente');
  assert.equal(diffShapes(shapeOf([]), shapeOf({}), [])[0].field, '(root)');
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({}), [], ['share']), []);
  assert.deepEqual(diffShapes(shapeOf({ mcp: { a: { type: 'local' } } }, 'config'), shapeOf({ mcp: {} }, 'config'), [], ['mcp']), []);
  assert.deepEqual(diffShapes(shapeOf({ share: 'auto' }), shapeOf({ share: true }), [], ['share']), [{ field: 'share', real: 'string', fake: 'boolean' }]);
});

test('probe verdicts require a tool attempt in the same turn', () => {
  assert.equal(toolAttempted([], [], 'bash'), false);
  const reason = 'o modelo não tentou a ferramenta';
  assert.equal(evidenceVerdict(toolAttempted([], [], 'bash'), true, reason), `INCONCLUSIVO (${reason})`);
  assert.equal(toolAttempted([{ tool: 'bash', status: 'error' }], [], 'bash'), true);
  assert.equal(toolAttempted([], [{ permission: 'bash' }], 'bash'), true);
  assert.equal(evidenceVerdict(true, true), 'DENY');
  assert.throws(() => evidenceVerdict(false, true), /motivo/i);
  assert.equal(evidenceVerdict(false, true, reason), `INCONCLUSIVO (${reason})`);
});

test('merge verdict requires a surviving pre-existing effective config value', () => {
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { model: 'private/model' }, overridePresent: true }), { verdict: 'MERGE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: { model: 'private/model' }, effectiveConfig: { share: 'disabled' }, overridePresent: true }), { verdict: 'REPLACE', key: 'model' });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true, reason: 'nenhuma chave de config do usuário para comparar' }), { verdict: 'INCONCLUSIVO (nenhuma chave de config do usuário para comparar)', key: null });
  assert.deepEqual(mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: { share: 'disabled' }, overridePresent: true, reason: 'nenhuma chave de config do usuário para comparar' }), { verdict: 'INCONCLUSIVO (nenhuma chave de config do usuário para comparar)', key: null });
  assert.throws(() => mergeVerdict({ overrideApplied: true, userConfig: {}, effectiveConfig: {}, overridePresent: false }), /motivo/i);
});

test('inconclusive MCP and config merge findings carry Portuguese reasons', () => {
  const mcp = evidenceVerdict(false, true, 'o modelo não tentou a ferramenta');
  assert.match(mcp, /^INCONCLUSIVO \(.+\)$/);
  assert.match(mcp, /o modelo não tentou a ferramenta/);
  const merge = mergeVerdict({
    overrideApplied: true,
    userConfig: {},
    effectiveConfig: { share: 'disabled' },
    overridePresent: true,
    reason: 'nenhuma chave de config do usuário para comparar',
  }).verdict;
  assert.match(merge, /^INCONCLUSIVO \(.+\)$/);
  assert.match(merge, /nenhuma chave de config do usuário para comparar/);
});

test('live diagnostics redact output and connection cleanup stops before tracked temp removal', () => {
  const root = path.resolve('tests/live');
  const probe = fs.readFileSync(path.join(root, 'probe-permission-precedence.mjs'), 'utf8');
  const connection = fs.readFileSync(path.join(root, 'f0-connection.mjs'), 'utf8');
  assert.match(probe, /process\.stderr\.write\(redactText\(/);
  assert.match(probe, /process\.stdout\.write\(redactText\(/);
  assert.match(probe, /toolAttempted\(deny\.tools, deny\.asked, toolId\)/);
  assert.match(probe, /approvedInA[\s\S]*?a\.tools\.some/);
  assert.match(connection, /trackTempDir\(t, makeTempDir\(/);
  assert.match(connection, /registerStopper\(t, \(\) => stopServer\(cleanupCtx/);
});

test('contract collection deadline uses monotonic performance time', () => {
  const source = fs.readFileSync(path.resolve('tests/live/contract.mjs'), 'utf8');
  assert.match(source, /const deadline = performance\.now\(\) \+ 15000/);
  assert.match(source, /while \(performance\.now\(\) < deadline/);
  assert.doesNotMatch(source, /const deadline = Date\.now\(\)/);
});
