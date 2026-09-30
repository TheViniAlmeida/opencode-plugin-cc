import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

export const PLAN = {
  rationale: 'Map the error paths and design the approach in parallel, then review with both results.',
  subtasks: [
    { id: 'a', title: 'Map error paths', prompt: 'List every place that throws or catches errors.', kind: 'ask', tier: 'light', dependsOn: [] },
    { id: 'b', title: 'Design error policy', prompt: 'Propose a consistent error policy.', kind: 'plan', dependsOn: [] },
    { id: 'c', title: 'Review against policy', prompt: 'Review the error paths against the proposed policy.', kind: 'review', files: ['src/index.mjs'], dependsOn: ['a', 'b'] },
  ],
};

export default makeOrchestrateScenario({ plan: PLAN });
