import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, testEnv, runCli, writeGlobalConfig, fakeRequests, eventually } from '../helpers.mjs';
import { F3_TEST_CONFIG } from '../fixtures/f3-fake.mjs';

async function setup(t, extra = {}) {
  const cwd = makeWorkspace(t);
  const env = testEnv(t, { scenario: 'group-slow', extra: { OPC_COMPANION_SESSION_ID: 'claude-f3-test', ...extra } });
  writeGlobalConfig(env, F3_TEST_CONFIG);
  return { cwd, env };
}

async function startGroup(env, cwd, models = 'fast,strong,k3') {
  const res = await runCli(['subagent', '--agent', 'general', '--model', models, '--background', '--json', 'p'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  return JSON.parse(res.stdout).group;
}

async function runningMembers(env, cwd, groupId) {
  return eventually(async () => {
    const res = await runCli(['status', groupId, '--json'], { env, cwd });
    const { members } = JSON.parse(res.stdout);
    return members.every((m) => m.status === 'running' && m.sessionID) ? members : null;
  }, { timeoutMs: 20000, intervalMs: 300 });
}

const aborts = (env) => fakeRequests(env).filter((r) => r.method === 'POST' && /\/interrupt$/.test(r.path)).map((r) => r.path);

test('grupo em segundo plano → status --wait agregado → resultado de todos os membros', async (t) => {
  const { cwd, env } = await setup(t);
  const group = await startGroup(env, cwd);
  const waited = await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200', '--json'], { env, cwd });
  assert.equal(waited.code, 0, waited.stderr);
  const out = JSON.parse(waited.stdout);
  assert.equal(out.group.status, 'completed');
  assert.equal(out.group.phase, '3/3 concluídas');
  assert.equal(out.members.length, 3);
  const text = await runCli(['status', group.id], { env, cwd });
  assert.match(text.stdout, /# Grupo /);
  const result = await runCli(['result', group.id], { env, cwd });
  assert.equal(result.code, 0);
  assert.equal((result.stdout.match(/RESULT general/g) ?? []).length, 3);
  const json = JSON.parse((await runCli(['result', group.id, '--json'], { env, cwd })).stdout);
  assert.equal(json.members.length, 3);
  const latest = JSON.parse((await runCli(['result', '--json'], { env, cwd })).stdout);
  assert.equal(latest.group.id, group.id);
  assert.equal(latest.members.length, 3);
});

test('a lista de status mostra o grupo, nunca seus membros', async (t) => {
  const { cwd, env } = await setup(t);
  const group = await startGroup(env, cwd, 'fast,strong');
  await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200'], { env, cwd });
  const members = JSON.parse((await runCli(['status', group.id, '--json'], { env, cwd })).stdout).members;
  const list = await runCli(['status', '--all'], { env, cwd });
  assert.match(list.stdout, new RegExp(group.id));
  for (const m of members) assert.doesNotMatch(list.stdout, new RegExp(m.id));
});

test('result em grupo ativo é recusado', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '5000' });
  const group = await startGroup(env, cwd, 'fast');
  const res = await runCli(['result', group.id], { env, cwd });
  assert.equal(res.code, 2);
  assert.match(res.stdout + res.stderr, /ainda está em execução/);
});

test('cancelar um membro aborta apenas sua sessão; os demais concluem', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd);
  const members = await runningMembers(env, cwd, group.id);
  const target = members[1];
  const cancel = await runCli(['cancel', target.id], { env, cwd });
  assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
  assert.deepEqual(aborts(env), [`/api/session/${target.sessionID}/interrupt`]);
  const waited = JSON.parse((await runCli(['status', group.id, '--wait', '--poll-interval-ms', '200', '--json'], { env, cwd })).stdout);
  assert.equal(waited.group.status, 'completed');
  assert.deepEqual(waited.members.map((m) => m.status), ['completed', 'cancelled', 'completed']);
  assert.match((await runCli(['result', group.id], { env, cwd })).stdout, /Cancelado\./);
});

test('cancelar o grupo aborta cada membro ativo e termina cancelado', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd);
  const members = await runningMembers(env, cwd, group.id);
  const res = await runCli(['cancel', group.id, '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).cancelledMembers.sort(), members.map((m) => m.id).sort());
  for (const m of members) assert.ok(aborts(env).includes(`/api/session/${m.sessionID}/interrupt`));
  const status = JSON.parse((await runCli(['status', group.id, '--json'], { env, cwd })).stdout);
  assert.equal(status.group.status, 'cancelled');
  assert.ok(status.members.every((m) => m.status === 'cancelled'));
  assert.equal((await runCli(['result', group.id], { env, cwd })).code, 130);
});

test('cancel sem id escolhe o único job de nível superior ativo (o grupo)', async (t) => {
  const { cwd, env } = await setup(t, { FAKE_GROUP_DELAY_MS: '6000' });
  const group = await startGroup(env, cwd, 'fast,strong');
  await runningMembers(env, cwd, group.id);
  const res = await runCli(['cancel', '--json'], { env, cwd });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).group.id, group.id);
});
