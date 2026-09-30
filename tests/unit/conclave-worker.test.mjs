import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroup, readJob, updateJob, recordAttempt, listGroupMembers, ACTIVE_STATUSES } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { ensurePrivateDir } from '../../plugins/opc/scripts/lib/state.mjs';
import { runWorker, finalizeConclaveCoordinatorFailure, renderConclaveForeground, presentConclaveResult } from '../../plugins/opc/scripts/commands/conclave.mjs';
import { makeTempDir, trackTempDir, fixtureData } from '../helpers.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import { MEMBERS, answer, synthesis, ok, failed } from './_conclave-fixtures.mjs';

function stateDir(t) {
  const dir = trackTempDir(t, makeTempDir('opc-conclave-worker-'));
  ensurePrivateDir(dir);
  return dir;
}

test('coordinator failure closes active members and judge before final group refresh', async (t) => {
  const dir = stateDir(t);
  const { group, members } = await createGroup(dir, { kind: 'conclave', title: 'test conclave', workspaceRoot: '/workspace' }, [
    { kind: 'conclave-member', title: 'member A', role: 'member:A' },
    { kind: 'conclave-judge', title: 'judge', role: 'judge' },
  ]);
  await updateJob(dir, group.id, { status: 'running' });
  for (const member of members) await updateJob(dir, member.id, { status: 'running', attemptInFlight: true });
  const error = Object.assign(new Error('event handler failed'), { code: 'COORDINATOR_ERROR' });
  const completedAt = '2026-09-30T12:00:00.000Z';
  const final = await finalizeConclaveCoordinatorFailure(dir, readJob(dir, group.id), members.map((member) => member.id), error, () => completedAt);
  assert.equal(final.status, 'failed');
  for (const member of members) {
    const closed = readJob(dir, member.id);
    assert.equal(closed.status, 'failed');
    assert.equal(closed.errorCode, 'coordinator_error');
    assert.equal(closed.attemptInFlight, false);
    assert.equal(closed.completedAt, completedAt);
  }
  assert.equal(final.result.members.some((member) => ['queued', 'running', 'waiting'].includes(member.status)), false);
});

test('coordinator failure cancels active children when cancellation was requested', async (t) => {
  const dir = stateDir(t);
  const { group, members } = await createGroup(dir, { kind: 'conclave', title: 'test conclave', workspaceRoot: '/workspace' }, [
    { kind: 'conclave-member', title: 'member A', role: 'member:A' },
  ]);
  await updateJob(dir, group.id, { status: 'running', cancelRequestedAt: '2026-09-30T11:59:00.000Z' });
  await updateJob(dir, members[0].id, { status: 'running', attemptInFlight: true });
  const final = await finalizeConclaveCoordinatorFailure(dir, readJob(dir, group.id), [members[0].id], new Error('cancel race'), () => '2026-09-30T12:00:00.000Z');
  const child = readJob(dir, members[0].id);
  assert.equal(child.status, 'cancelled');
  assert.equal(child.attemptInFlight, false);
  assert.equal(child.completedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(final.status, 'cancelled');
});

test('foreground failure summary does not render a partial conclave package', () => {
  const out = renderConclaveForeground({ id: 'conc-test', status: 'failed', errorCode: 'coordinator_error', errorMessage: 'event write failed' });
  assert.match(out, /Status:\*\* failed/);
  assert.match(out, /Código:\*\* coordinator_error/);
  assert.match(out, /Erro:\*\* event write failed/);
  assert.doesNotMatch(out, /Síntese|Rodadas|Válidos/);
});

test('presenter handles failed refreshed group summaries in text and JSON modes', () => {
  const job = { id: 'conc-test', status: 'failed', errorCode: 'coordinator_error', errorMessage: 'provider unavailable', result: { counts: { failed: 1 }, warnings: [], members: [] } };
  let output = '';
  const code = presentConclaveResult({ out: (value) => { output = value; } }, job, false);
  assert.equal(code, 7);
  assert.match(output, /Status:\*\* failed/);
  assert.match(output, /Código:\*\* coordinator_error/);
  assert.match(output, /Erro:\*\* provider unavailable/);
  let json;
  const jsonCode = presentConclaveResult({ json: (value) => { json = value; } }, job, true);
  assert.equal(jsonCode, 7);
  assert.deepEqual(json, { jobId: 'conc-test', status: 'failed', errorCode: 'coordinator_error', errorMessage: 'provider unavailable' });
});

async function workerFixture(t) {
  const dir = stateDir(t);
  const { group, members } = await createGroup(dir, { kind: 'conclave' }, [
    ...MEMBERS.map((m) => ({ kind: 'conclave-member', role: `member:${m.label}`, model: m.full })),
    { kind: 'conclave-judge', role: 'judge', model: MEMBERS[2].full },
  ]);
  const listeners = new Set();
  const prompts = [];
  const fake = { state: {}, persist() {}, emit(event) { for (const fn of listeners) fn(structuredClone(event)); },
    scenario: { async onPromptAsync(f, id, body) {
      prompts.push(id);
      const response = f.state.sessions[id].title === 'OPC: conclave: judge' ? synthesis(['A', 'B', 'C']) : answer();
      f.emitTurn(id, { text: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``, delayMs: 1 });
    } },
  };
  const routes = installSessionApi(fake);
  const handle = async (method, route, body, options) => {
    const response = await routes.handle(method, route, new URLSearchParams(options?.query), body);
    assert.ok(response.status < 400, `${method} ${route}: ${response.status}`);
    return response.body;
  };
  const api = createApi({ get: (route, options) => handle('GET', route, undefined, options), post: (route, body) => handle('POST', route, body), patch: (route, body) => handle('PATCH', route, body) });
  api.providers = async () => fixtureData('provider.json');
  const hub = { track(_id, fn) { listeners.add(fn); return () => listeners.delete(fn); }, onReconnect() { return () => {}; } };
  const ctx = { stateDir: dir, workspaceRoot: dir, cwd: dir, config: { conclave: { structuredOutput: 'text', memberTimeoutSec: 2 }, jobs: { maxParallel: 2 } } };
  const request = { question: 'Should we add a log?', mode: 'opinion', rounds: 1, quorum: 2, members: MEMBERS, judge: { type: 'model', ...MEMBERS[2] } };
  let closed = false;
  const options = { openApiImpl: async () => ({ api, hub, close() { closed = true; } }) };
  return { ctx, group, members, request, options, fake, prompts, closed: () => closed };
}

for (const role of ['member:A', 'judge']) {
  for (const operation of ['updateJob', 'onSession', 'recordAttempt']) {
    test(`${role} ${operation} persistence failure finalizes coordinator_error with no active children`, async (t) => {
      const f = await workerFixture(t);
      const target = f.members.find((m) => m.role === role).id;
      let injected = false;
      const fail = () => { injected = true; throw Object.assign(new Error(`${operation} write failed`), { code: 'EIO' }); };
      f.options.updateJobImpl = async (dir, id, patch) => {
        if (id === target && !injected && ((operation === 'updateJob' && patch.attemptInFlight) || (operation === 'onSession' && patch.sessionID))) fail();
        return updateJob(dir, id, patch);
      };
      f.options.recordAttemptImpl = async (dir, id, attempt) => {
        if (id === target && operation === 'recordAttempt' && !injected) fail();
        return recordAttempt(dir, id, attempt);
      };
      assert.equal(await runWorker(f.ctx, f.group, f.request, f.options), 7);
      assert.equal(injected, true, JSON.stringify(readJob(f.ctx.stateDir, f.group.id).result));
      assert.equal(f.closed(), true);
      const group = readJob(f.ctx.stateDir, f.group.id);
      assert.equal(group.status, 'failed');
      assert.equal(group.errorCode, 'coordinator_error');
      assert.equal(group.errorMessage, `${operation} write failed`);
      for (const child of listGroupMembers(f.ctx.stateDir, f.group.id)) {
        assert.equal(ACTIVE_STATUSES.includes(child.status), false);
        assert.equal(child.attemptInFlight, false);
      }
      assert.ok(group.result.members.every((m) => !ACTIVE_STATUSES.includes(m.status)));
      if (operation === 'onSession') {
        const title = role === 'judge' ? 'OPC: conclave: judge' : 'OPC: conclave: A:';
        const session = Object.values(f.fake.state.sessions).find((s) => s.title.startsWith(title));
        assert.ok(session);
        assert.ok(f.fake.state.aborts.includes(session.id));
        assert.equal(f.prompts.includes(session.id), false);
      }
    });
  }
}

for (const outcome of ['failed', 'cancelled', 'thrown']) {
  test(`worker keeps ${outcome} runner outcomes as member failures`, async (t) => {
    const f = await workerFixture(t);
    f.request.judge = { type: 'claude' };
    f.options.turnRunner = async ({ request }) => {
      if (request.newSession.title.startsWith('OPC: conclave: A:')) {
        if (outcome === 'thrown') throw Object.assign(new Error('runner failed'), { code: 'SERVER_DOWN' });
        return { ...failed('Timeout'), status: outcome };
      }
      return ok(answer(), 'ses_fixture');
    };
    assert.equal(await runWorker(f.ctx, f.group, f.request, f.options), 0);
    const group = readJob(f.ctx.stateDir, f.group.id);
    assert.equal(group.status, 'completed');
    assert.deepEqual(group.result.failures.map((f) => [f.label, f.errorType]), [['A', outcome === 'thrown' ? 'SERVER_DOWN' : outcome === 'cancelled' ? 'Cancelled' : 'Timeout']]);
  });
}
