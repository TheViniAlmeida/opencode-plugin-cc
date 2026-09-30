import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

export const PLAN = {
  rationale: 'a fails, b depends on a, c is independent.',
  subtasks: [
    { id: 'a', title: 'Fails', prompt: 'This one fails.', kind: 'ask', dependsOn: [] },
    { id: 'b', title: 'Depends on a', prompt: 'Uses a.', kind: 'ask', dependsOn: ['a'] },
    { id: 'c', title: 'Independent', prompt: 'Runs anyway.', kind: 'ask', dependsOn: [] },
  ],
};

export default makeOrchestrateScenario({ plan: PLAN, failSubtasks: ['a'] });
