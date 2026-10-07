// Exercise the real coordinator, runner and fake API routes without listening sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { createGroup, readJob, listGroupMembers, cancelJob, cancelGroup, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { runWorker } from '../../plugins/opc/scripts/commands/orchestrate.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import { makeTempDir, trackTempDir, FIXTURE_MODELS, waitFor } from '../helpers.mjs';
import { makeCatalog } from './_conclave-fixtures.mjs';

const plan = { rationale: 'Two independent questions.', subtasks: ['a', 'b'].map((id) => ({ id, title: id, prompt: `Answer ${id}`, kind: 'ask', dependsOn: [] })) };
function fixture(t, { mode = 'text', slow = false } = {}) {
  const stateDir = trackTempDir(t, makeTempDir('opc-gate-'));
  const listeners = new Set();
  const prompts = [];
  const fake = { state: {}, persist() {}, emit(event) { for (const fn of listeners) fn(structuredClone(event)); },
    scenario: { async onPrompt(f, id, body) {
      prompts.push(body);
      if (f.state.sessions[id].title.startsWith('OPC: orch-plan:')) {
        return f.emitTurn(id, { text: JSON.stringify(plan), delayMs: 1 });
      }
      return f.emitTurn(id, { text: 'answer', delayMs: slow ? 30000 : 1 });
    } },
  };
  const routes = installSessionApi(fake);
  const handle = async (method, route, body, options) => {
    const response = await routes.handle(method, route, new URLSearchParams(options?.query), body);
    if ((response.status ?? 200) >= 400) throw new RequestError('BAD_REQUEST', 'requisição recusada', { details: { body: response.body } });
    return response.body?.data ?? response.body;
  };
  const api = createApi({ get: (route, options) => handle('GET', route, undefined, options), post: (route, body) => handle('POST', route, body), patch: (route, body) => handle('PATCH', route, body) });
  const hub = { track(_id, fn) { listeners.add(fn); return () => listeners.delete(fn); }, onReconnect() { return () => {}; } };
  const full = FIXTURE_MODELS.fast;
  const [providerID, ...modelParts] = full.split('/');
  const ctx = { stateDir, workspaceRoot: path.join(stateDir, 'workspace'), config: { defaultModel: full, orchestrate: { structuredOutput: mode }, jobs: { maxParallel: 1 } }, env: {} };
  const request = { task: 'Answer two questions', synthesizer: 'claude', timeoutSec: 5, plannerRoute: { candidates: [{ providerID, modelID: modelParts.join('/'), full }] } };
  const options = { openApiImpl: async () => ({ api, hub, close() {} }), discoveryLoader: async () => ({ agents: [], catalog: makeCatalog() }) };
  return { ctx, request, options, prompts, fake, api };
}

for (const mode of ['text', 'tool']) {
  test(`I4: real worker completes a fake planner and subtasks in ${mode} mode`, async (t) => {
    const { ctx, request, options, prompts } = fixture(t, { mode });
    const { group } = await createGroup(ctx.stateDir, { kind: 'orch', status: 'queued' }, []);
    assert.equal(await runWorker(ctx, group, request, options), 0, JSON.stringify(readJob(ctx.stateDir, group.id)?.result));
    const stored = readJob(ctx.stateDir, group.id);
    assert.equal(stored.status, 'completed');
    assert.deepEqual(stored.result.subtasks.map((s) => s.status), ['completed', 'completed']);
    assert.equal(prompts.length, 3);
    assert.equal(Object.hasOwn(prompts[0], 'format'), false);
    assert.match(prompts[0].text, /Reply with only one JSON object/);
    assert.ok(prompts.slice(1).every((body) => !Object.hasOwn(body, 'format')));
    assert.ok(listGroupMembers(ctx.stateDir, group.id).every((m) => m.sessionID && m.status === 'completed'));
  });
}

test('C1: real worker publishes an active session so cancelJob aborts it and group exits 130', async (t) => {
  const { ctx, request, options, fake, api } = fixture(t, { slow: true });
  const { group } = await createGroup(ctx.stateDir, { kind: 'orch', status: 'queued' }, []);
  const worker = runWorker(ctx, group, request, options);
  const session = await waitFor(() => Object.values(fake.state.sessions).find((s) => s.title.startsWith('OPC: orch-ask:') && fake.state.statuses[s.id]?.type === 'running'));
  const member = listGroupMembers(ctx.stateDir, group.id).find((m) => m.role === 'worker:1');
  assert.equal(member.sessionID, session.id);
  assert.equal(member.attemptInFlight, true);
  assert.deepEqual(member.attempts ?? [], []);
  await updateJob(ctx.stateDir, group.id, { cancelRequestedAt: new Date().toISOString() });
  const cancelled = await cancelJob(ctx, member.id, { api });
  assert.notEqual(cancelled.ok, false);
  assert.ok(fake.state.aborts.includes(session.id));
  assert.equal(await worker, 130);
  assert.equal(readJob(ctx.stateDir, group.id).status, 'cancelled');
});

for (const target of ['group', 'member']) {
  test(`F4b fix2: real worker honors ${target} cancellation while session creation is blocked`, async (t) => {
    const { ctx, request, options, fake, api } = fixture(t);
    const { group } = await createGroup(ctx.stateDir, { kind: 'orch' }, []);
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const create = api.createSession;
    let delayedSession;
    api.createSession = async (body) => {
      if (body.title.startsWith('OPC: orch-ask: a ')) { entered(); await blocked; delayedSession = await create(body); return delayedSession; }
      return create(body);
    };
    const worker = runWorker(ctx, group, request, options);
    await started;
    const member = listGroupMembers(ctx.stateDir, group.id).find((m) => m.role === 'worker:1');
    assert.equal(member.sessionID, null);
    assert.equal(member.attemptInFlight, true);
    let result;
    try {
      result = target === 'group' ? await cancelGroup(ctx, group.id) : await cancelJob(ctx, member.id, { api, exitWaitMs: 1 });
    } finally { release(); }
    const exitCode = await worker;
    assert.equal(result.ok, true);
    assert.equal(target === 'group' ? result.deferred : result.report.deferred, true);
    assert.equal(fake.state.messages[delayedSession.id].filter((m) => m.type === 'user').length, 0);
    assert.ok(fake.state.aborts.includes(delayedSession.id));
    const saved = readJob(ctx.stateDir, member.id);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.attempts[0].status, 'cancelled');
    assert.equal(saved.attemptInFlight, false);
    assert.equal(exitCode, target === 'group' ? 130 : 0);
    assert.equal(readJob(ctx.stateDir, group.id).status, target === 'group' ? 'cancelled' : 'completed');
    if (target === 'member') assert.equal(listGroupMembers(ctx.stateDir, group.id).find((m) => m.role === 'worker:2').status, 'completed');
  });
}
