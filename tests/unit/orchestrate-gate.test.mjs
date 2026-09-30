// Exercise the real coordinator, runner and fake API routes without listening sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApi } from '../../plugins/opc/scripts/lib/api.mjs';
import { buildCatalog } from '../../plugins/opc/scripts/lib/models.mjs';
import { createGroup, readJob, listGroupMembers, cancelJob, updateJob } from '../../plugins/opc/scripts/lib/jobs.mjs';
import { runWorker } from '../../plugins/opc/scripts/commands/orchestrate.mjs';
import { RequestError } from '../../plugins/opc/scripts/lib/opc-error.mjs';
import { installSessionApi } from '../fixtures/fake-session-api.mjs';
import { makeTempDir, trackTempDir, fixtureData, FIXTURE_MODELS, waitFor } from '../helpers.mjs';

const plan = { rationale: 'Two independent questions.', subtasks: ['a', 'b'].map((id) => ({ id, title: id, prompt: `Answer ${id}`, kind: 'ask', dependsOn: [] })) };
function fixture(t, { mode = 'text', slow = false } = {}) {
  const stateDir = trackTempDir(t, makeTempDir('opc-gate-'));
  const listeners = new Set();
  const prompts = [];
  const fake = { state: {}, persist() {}, emit(event) { for (const fn of listeners) fn(structuredClone(event)); },
    scenario: { formatListError: true, async onPromptAsync(f, id, body) {
      prompts.push(body);
      if (f.state.sessions[id].title.startsWith('OPC: orch-plan:')) {
        return f.emitTurn(id, mode === 'tool' ? { text: '', structured: plan, delayMs: 1 } : { text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, delayMs: 1 });
      }
      return f.emitTurn(id, { text: 'answer', delayMs: slow ? 30000 : 1 });
    } },
  };
  const routes = installSessionApi(fake);
  const handle = async (method, route, body, options) => {
    const response = await routes.handle(method, route, new URLSearchParams(options?.query), body);
    if (response.status >= 400) throw new RequestError('BAD_REQUEST', 'requisição recusada', { details: { body: response.body } });
    return response.body;
  };
  const api = createApi({ get: (route, options) => handle('GET', route, undefined, options), post: (route, body) => handle('POST', route, body), patch: (route, body) => handle('PATCH', route, body) });
  const hub = { track(_id, fn) { listeners.add(fn); return () => listeners.delete(fn); }, onReconnect() { return () => {}; } };
  const full = FIXTURE_MODELS.fast;
  const [providerID, ...modelParts] = full.split('/');
  const ctx = { stateDir, workspaceRoot: path.join(stateDir, 'workspace'), config: { defaultModel: full, orchestrate: { structuredOutput: mode }, jobs: { maxParallel: 1 } }, env: {} };
  const request = { task: 'Answer two questions', synthesizer: 'claude', timeoutSec: 5, plannerRoute: { candidates: [{ providerID, modelID: modelParts.join('/'), full }] } };
  const options = { openApiImpl: async () => ({ api, hub, close() {} }), discoveryLoader: async () => ({ agents: [], catalog: buildCatalog(fixtureData('provider.json')) }) };
  return { ctx, request, options, prompts, fake, api };
}

for (const mode of ['text', 'tool']) {
  test(`I4: real worker completes a fake planner and subtasks in ${mode} mode`, async (t) => {
    const { ctx, request, options, prompts } = fixture(t, { mode });
    const { group } = await createGroup(ctx.stateDir, { kind: 'orch', status: 'queued' }, []);
    assert.equal(await runWorker(ctx, group, request, options), 0);
    const stored = readJob(ctx.stateDir, group.id);
    assert.equal(stored.status, 'completed');
    assert.deepEqual(stored.result.subtasks.map((s) => s.status), ['completed', 'completed']);
    assert.equal(prompts.length, 3);
    if (mode === 'tool') assert.equal(prompts[0].format.type, 'json_schema');
    else assert.equal(Object.hasOwn(prompts[0], 'format'), false);
    assert.ok(prompts.slice(1).every((body) => !Object.hasOwn(body, 'format')));
    assert.ok(listGroupMembers(ctx.stateDir, group.id).every((m) => m.sessionID && m.status === 'completed'));
  });
}

test('C1: real worker publishes an active session so cancelJob aborts it and group exits 130', async (t) => {
  const { ctx, request, options, fake, api } = fixture(t, { slow: true });
  const { group } = await createGroup(ctx.stateDir, { kind: 'orch', status: 'queued' }, []);
  const worker = runWorker(ctx, group, request, options);
  const session = await waitFor(() => Object.values(fake.state.sessions).find((s) => s.title.startsWith('OPC: orch-ask:') && fake.state.statuses[s.id]?.type === 'busy'));
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
