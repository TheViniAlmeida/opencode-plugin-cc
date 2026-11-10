import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as configModule from '../../plugins/opc/scripts/lib/config.mjs';
import { DEFAULT_CONFIG, delegationAutoEnabled, getPath, mergeConfig, setPath } from '../../plugins/opc/scripts/lib/config.mjs';
import { delegationReminder, DELEGATION_COMMANDS } from '../../plugins/opc/scripts/lib/render.mjs';

const numericLimits = [
  ['routing.fallback.maxAttempts', 2, 1, 10],
  ['routing.fallback.maxProviderRetries', 2, 0, 10],
  ['routing.fallback.maxRetryWaitSec', 30, 0, 120],
  ['conclave.rounds', 2, 1, 3],
  ['conclave.memberTimeoutSec', 600, 300, 1200],
  ['orchestrate.maxSubtasks', 4, 2, 10],
];

test('WORKSPACE_TIGHTEN_ONLY exports exactly the six numeric limits', () => {
  assert.deepEqual(configModule.WORKSPACE_TIGHTEN_ONLY, numericLimits.map(([key]) => key));
});

for (const [key, globalValue, tighter, wider] of numericLimits) {
  test(`workspace can only tighten ${key} against global or default`, () => {
    for (const global of [{}, setPath({}, key, globalValue)]) {
      const baseline = getPath(global, key) ?? getPath(DEFAULT_CONFIG, key);
      for (const value of [tighter, baseline, wider]) {
        const { config, warnings } = mergeConfig(global, setPath({}, key, value));
        assert.equal(getPath(config, key), Math.min(baseline, value));
        if (value > baseline) {
          assert.ok(warnings.some((w) => w.path === key && w.message === `"${key}": o workspace só pode apertar (global/padrão = ${baseline}); valor do workspace ignorado.`));
        } else assert.deepEqual(warnings, []);
      }
      const invalid = mergeConfig(global, setPath({}, key, 'invalid'));
      assert.equal(getPath(invalid.config, key), baseline);
      assert.ok(invalid.warnings.some((w) => w.path === key));
      assert.equal(getPath(mergeConfig(global, {}).config, key), baseline);
    }
  });
}

test('workspace tightening preserves other routing and delegation preferences', () => {
  const { config, warnings } = mergeConfig(
    { routing: { fallback: { maxAttempts: 2 } }, delegation: { auto: true } },
    { routing: { tasks: { ask: ['p/m'] }, fallback: { maxAttempts: 10, enabled: false } }, conclave: { rounds: 1 }, delegation: { auto: false } },
  );
  assert.equal(config.routing.fallback.maxAttempts, 2);
  assert.equal(config.routing.fallback.enabled, false);
  assert.deepEqual(config.routing.tasks.ask, ['p/m']);
  assert.equal(config.conclave.rounds, 1);
  assert.equal(config.delegation.auto, false);
  assert.ok(warnings.some((w) => w.path === 'routing.fallback.maxAttempts' && /apertar/.test(w.message)));
});

test('delegationAutoEnabled: somente a configuração global pode ativar', () => {
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: true } }, workspace: null }), true);
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: false } }, workspace: null }), false);
  assert.equal(delegationAutoEnabled({ global: null, workspace: null }), false);
  assert.equal(delegationAutoEnabled({}), false);
  assert.equal(delegationAutoEnabled(), false);
});

test('delegationAutoEnabled: workspace pode desativar, nunca ativar', () => {
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: true } }, workspace: { delegation: { auto: false } } }), false);
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: false } }, workspace: { delegation: { auto: true } } }), false);
  assert.equal(delegationAutoEnabled({ global: null, workspace: { delegation: { auto: true } } }), false);
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: true } }, workspace: {} }), true);
});

test('delegationAutoEnabled exige true literal', () => {
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: 'true' } } }), false);
  assert.equal(delegationAutoEnabled({ global: { delegation: { auto: 1 } } }), false);
});

test('DELEGATION_COMMANDS lista ask, plan, review, orchestrate e conclave', () => {
  assert.deepEqual(DELEGATION_COMMANDS.map((c) => c.slash), ['/opc:ask', '/opc:plan', '/opc:review', '/opc:orchestrate', '/opc:conclave']);
  for (const c of DELEGATION_COMMANDS) assert.ok(c.cli.startsWith('opc ') && c.use.length > 0);
  assert.equal(DELEGATION_COMMANDS.at(-1).use, 'consulta paralela, debate e revisão por vários modelos');
});

test('delegationReminder lista comandos e regras em menos de 1.000 caracteres', () => {
  const text = delegationReminder();
  for (const c of DELEGATION_COMMANDS) {
    assert.ok(text.includes(c.cli), c.cli);
    assert.ok(text.includes(c.slash), c.slash);
  }
  assert.match(text, /delegation\.auto/);
  assert.match(text, /opc-delegation/);
  assert.match(text, /Nunca encadeie delegações/);
  assert.match(text, /aprovadora/);
  assert.match(text, /pequenas edições/);
  assert.ok(text.length < 1000, `comprimento ${text.length}`);
});

test('delegationReminder aceita comandos adicionais', () => {
  const text = delegationReminder([...DELEGATION_COMMANDS, { cli: 'opc orchestrate', slash: '/opc:orchestrate', use: 'trabalho em várias partes' }]);
  assert.match(text, /`opc orchestrate` \(\/opc:orchestrate\)/);
});

test('mergeConfig: workspace delegation.auto false applies silently; true is ignored with a clear warning', () => {
  const off = mergeConfig({ delegation: { auto: true } }, { delegation: { auto: false } });
  assert.equal(off.config.delegation.auto, false);
  assert.deepEqual(off.warnings, []);
  const on = mergeConfig({ delegation: { auto: false } }, { delegation: { auto: true } });
  assert.equal(on.config.delegation.auto, false);
  assert.deepEqual(on.warnings.map((w) => [w.path, w.message]), [['delegation.auto', '.opc.json: o workspace só pode desligar (false); ignorado']]);
});
