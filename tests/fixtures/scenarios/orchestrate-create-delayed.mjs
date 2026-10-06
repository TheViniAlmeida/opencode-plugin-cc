import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

const normal = makeOrchestrateScenario({ plan: {
  rationale: 'Write first, then inspect the result.',
  subtasks: [
    { id: 'a', title: 'Delayed write', prompt: 'Update the disposable file.', kind: 'task', dependsOn: [] },
    { id: 'b', title: 'Inspect write', prompt: 'Inspect the result.', kind: 'ask', dependsOn: ['a'] },
  ],
} });

export default {
  ...normal,
  routes: {
    async 'POST /api/session'(fake, { body }) {
      if (!body?.title?.startsWith('OPC: orch-task:')) return;
      fake.state.delayedCreateStartedAt = Date.now();
      fake.persist();
      // Longer than both the member publication wait and the worker-exit wait.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      fake.state.delayedCreateFinishedAt = Date.now();
      fake.persist();
      // Fall through to the real fake-session API validation and creation.
    },
  },
};
