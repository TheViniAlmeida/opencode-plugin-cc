import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG, LOCKED_KEYS, getPath, loadConfig, matchesGlob, mergeConfig, saveGlobalConfig, saveWorkspaceConfig,
  setPath, validateConfigShape,
} from '../../plugins/opc/scripts/lib/config.mjs';
import { makeTempDir, removeTempDir } from '../helpers.mjs';

function temp(t) {
  const dir = makeTempDir('opc-cfg-');
  t.after(() => removeTempDir(dir));
  return dir;
}

const paths = (warnings) => warnings.map((w) => w.path);

test('DEFAULT_CONFIG is neutral and LOCKED_KEYS match spec §3.3', () => {
  assert.deepEqual(DEFAULT_CONFIG.policy.models, { allow: [], deny: [] });
  assert.deepEqual(DEFAULT_CONFIG.aliases, {});
  assert.equal(DEFAULT_CONFIG.policy.approver, 'user');
  assert.deepEqual(DEFAULT_CONFIG.server, { bootTimeoutSec: 60, requestTimeoutSec: 30, configOverride: { share: 'disabled' } });
  assert.deepEqual(DEFAULT_CONFIG.jobs, { maxActive: 8, maxParallel: 4 });
  assert.deepEqual([...LOCKED_KEYS], ['policy', 'permissionProfiles', 'server.configOverride']);
});

test('getPath/setPath use dotted paths and setPath is immutable', () => {
  const obj = { a: { b: { c: 1 } } };
  assert.equal(getPath(obj, 'a.b.c'), 1);
  assert.equal(getPath(obj, 'a.x.c'), undefined);
  const next = setPath(obj, 'a.b.d', 2);
  assert.deepEqual(next, { a: { b: { c: 1, d: 2 } } });
  assert.deepEqual(obj, { a: { b: { c: 1 } } });
  assert.deepEqual(setPath(undefined, 'x.y', 3), { x: { y: 3 } });
});

test('matchesGlob: * matches any sequence including /', () => {
  assert.equal(matchesGlob('omniroute-mvalmeida/opencode-go/kimi-k3', 'omniroute-mvalmeida/*'), true);
  assert.equal(matchesGlob('anthropic/claude', 'anthropic/*'), true);
  assert.equal(matchesGlob('work-review', 'work-*'), true);
  assert.equal(matchesGlob('prov.a/x', 'prov.a/x'), true);
  assert.equal(matchesGlob('provXa/x', 'prov.a/x'), false);
});

test('validateConfigShape reports type errors, unknown keys and secret-looking keys', () => {
  const { errors, warnings } = validateConfigShape({
    defaultModel: 3,
    policy: { approver: 'robot', models: { allow: 'x' } },
    jobs: { maxActive: 0 },
    mystery: true,
    aliases: { apiToken: 'x' },
  }, { source: 'global' });
  assert.deepEqual(paths(errors).sort(), ['defaultModel', 'jobs.maxActive', 'policy.approver', 'policy.models.allow']);
  assert.ok(paths(warnings).includes('mystery'));
  assert.ok(paths(warnings).includes('aliases.apiToken'));
  assert.deepEqual(validateConfigShape([], {}).errors.map((e) => e.path), ['']);
});

test('validateConfigShape rejects non-object policy sections', () => {
  assert.ok(validateConfigShape({ policy: { models: null } }).errors.some((e) => e.path === 'policy.models'));
  assert.ok(validateConfigShape({ policy: { agents: 'x' } }).errors.some((e) => e.path === 'policy.agents'));
});

test('validateConfigShape warns about locked keys only for the workspace source', () => {
  const cfg = { permissionProfiles: {}, server: { configOverride: {} } };
  assert.deepEqual(paths(validateConfigShape(cfg, { source: 'workspace' }).warnings).sort(), ['permissionProfiles', 'server.configOverride']);
  assert.deepEqual(validateConfigShape(cfg, { source: 'global' }).warnings, []);
});

test('mergeConfig applies global over defaults', () => {
  const { config, warnings } = mergeConfig({ defaultModel: 'p/m', jobs: { maxActive: 3 } }, null);
  assert.equal(config.defaultModel, 'p/m');
  assert.deepEqual(config.jobs, { maxActive: 3, maxParallel: 4 });
  assert.deepEqual(warnings, []);
});

test('workspace deny lists are unioned with the global ones', () => {
  const { config } = mergeConfig(
    { policy: { models: { deny: ['a/*'] }, agents: { deny: ['work-*'] } } },
    { policy: { models: { deny: ['b/*', 'a/*'] }, tools: { deny: ['gitlab_*'] } } },
  );
  assert.deepEqual(config.policy.models.deny, ['a/*', 'b/*']);
  assert.deepEqual(config.policy.agents.deny, ['work-*']);
  assert.deepEqual(config.policy.tools.deny, ['gitlab_*']);
});

test('workspace allow is retained separately for restrictive intersection', () => {
  const g = { policy: { models: { allow: ['prov-a/*', 'anthropic/claude-x'] } } };
  const narrow = mergeConfig(g, { policy: { models: { allow: ['prov-a/fast-*', 'anthropic/*'] } } });
  assert.deepEqual(narrow.config.policy.models.allow, ['prov-a/*', 'anthropic/claude-x']);
  assert.deepEqual(narrow.config.policy.models.allowWorkspace, ['prov-a/fast-*', 'anthropic/*']);
  const widen = mergeConfig(g, { policy: { models: { allow: ['prov-b/*'] } } });
  assert.deepEqual(widen.config.policy.models.allow, ['prov-a/*', 'anthropic/claude-x']);
  assert.deepEqual(widen.config.policy.models.allowWorkspace, ['prov-b/*']);
  assert.ok(widen.warnings.some((w) => w.path === 'policy.models.allow' && /interseção/.test(w.message)));
  const openGlobal = mergeConfig({}, { policy: { models: { allow: ['prov-a/*'] } } });
  assert.deepEqual(openGlobal.config.policy.models.allow, []);
  assert.deepEqual(openGlobal.config.policy.models.allowWorkspace, ['prov-a/*']);
  const openWs = mergeConfig(g, { policy: { models: { allow: [] } } });
  assert.deepEqual(openWs.config.policy.models.allow, ['prov-a/*', 'anthropic/claude-x']);
});

test('locked keys in the workspace are ignored with a warning (only restrictive policy forms pass)', () => {
  const { config, warnings } = mergeConfig(
    { policy: { approver: 'user', permissionTimeoutSec: 600 } },
    {
      policy: { approver: 'claude', permissionTimeoutSec: 5, sensitivePaths: ['*.secret'] },
      permissionProfiles: { yolo: [{ permission: '*', pattern: '*', action: 'allow' }] },
      server: { configOverride: { share: 'auto' }, bootTimeoutSec: 1 },
    },
  );
  assert.equal(config.policy.approver, 'user');
  assert.equal(config.policy.permissionTimeoutSec, 600);
  assert.ok(config.policy.sensitivePaths.includes('*.secret'));
  assert.deepEqual(config.permissionProfiles, {});
  assert.deepEqual(config.server.configOverride, { share: 'disabled' });
  assert.equal(config.server.bootTimeoutSec, 60);
  const p = paths(warnings);
  for (const expected of ['policy.approver', 'policy.permissionTimeoutSec', 'permissionProfiles', 'server']) {
    assert.ok(p.includes(expected), `missing warning for ${expected}: ${p.join(', ')}`);
  }
  const stricter = mergeConfig({ policy: { approver: 'claude' } }, { policy: { approver: 'user' } });
  assert.equal(stricter.config.policy.approver, 'claude');
});

test('preference scalars are overridable; other keys are not', () => {
  const { config, warnings } = mergeConfig(
    { defaultModel: 'g/m', aliases: { fast: 'g/f' }, delegation: { auto: false } },
    { defaultModel: 'w/m', aliases: { strong: 'w/s' }, stopGate: { model: 'w/gate', enabled: true }, delegation: { auto: true }, jobs: { maxActive: 99 } },
  );
  assert.equal(config.defaultModel, 'w/m');
  assert.deepEqual(config.aliases, { fast: 'g/f', strong: 'w/s' });
  assert.equal(config.stopGate.model, 'w/gate');
  assert.equal(config.stopGate.enabled, false);
  assert.equal(config.delegation.auto, false);
  assert.equal(config.jobs.maxActive, 8);
  assert.deepEqual(paths(warnings).sort(), ['delegation', 'jobs', 'jobs.maxActive', 'stopGate.enabled']);
});

test('invalid workspace values are dropped with a warning', () => {
  const { config, warnings } = mergeConfig({}, { defaultModel: 42 });
  assert.equal(config.defaultModel, null);
  assert.ok(paths(warnings).includes('defaultModel'));
});

test('loadConfig surfaces invalid JSON or shape in global and workspace files', (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  const first = loadConfig({ dataDir, workspaceRoot: ws });
  assert.equal(first.hasGlobal, false);
  assert.equal(first.global, null);
  assert.equal(first.workspace, null);
  assert.deepEqual(first.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fs.writeFileSync(path.join(ws, '.opc.json'), 'null');
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.exitCode === 2);
  fs.unlinkSync(path.join(ws, '.opc.json'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), 'null');
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.exitCode === 2);
  fs.unlinkSync(path.join(dataDir, 'config.json'));
  fs.writeFileSync(path.join(ws, '.opc.json'), '{broken');
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.exitCode === 2);
  fs.writeFileSync(path.join(ws, '.opc.json'), JSON.stringify({ policy: { models: null } }));
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.details.errors.some((x) => x.path === 'policy.models'));
  fs.writeFileSync(path.join(ws, '.opc.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{broken');
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.exitCode === 2);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ jobs: { maxActive: -1 } }));
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && /jobs\.maxActive/.test(e.message));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ policy: { models: null } }));
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'CONFIG_INVALID' && e.details.errors.some((x) => x.path === 'policy.models'));
});

test('loadConfig preserves structured secret-like warnings for workspace config', (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  fs.writeFileSync(path.join(ws, '.opc.json'), JSON.stringify({ apiToken: 'placeholder' }));
  const loaded = loadConfig({ dataDir, workspaceRoot: ws });
  assert.ok(loaded.warnings.some((warning) => warning.path === 'apiToken' && warning.code === 'SECRET_LIKE_KEY'));
});

test('loadConfig rejects unreadable .opc.json with READ_FAILED', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  const file = path.join(ws, '.opc.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0);
  assert.throws(() => loadConfig({ dataDir, workspaceRoot: ws }), (e) => e.code === 'READ_FAILED' && e.exitCode === 5 && e.details.path === file);
});

test('saveGlobalConfig (600) and saveWorkspaceConfig (644) round-trip through loadConfig', { skip: process.platform === 'win32' }, (t) => {
  const dataDir = temp(t);
  const ws = temp(t);
  saveGlobalConfig(dataDir, { defaultModel: 'p/m' });
  saveWorkspaceConfig(ws, { defaultModel: 'p/w' });
  assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(ws, '.opc.json')).mode & 0o777, 0o644);
  const loaded = loadConfig({ dataDir, workspaceRoot: ws });
  assert.equal(loaded.hasGlobal, true);
  assert.equal(loaded.config.defaultModel, 'p/w');
  assert.deepEqual(loaded.global, { defaultModel: 'p/m' });
});
