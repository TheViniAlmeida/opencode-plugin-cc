import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegationAutoEnabled } from '../../plugins/opc/scripts/lib/config.mjs';
import { delegationReminder, DELEGATION_COMMANDS } from '../../plugins/opc/scripts/lib/render.mjs';

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
