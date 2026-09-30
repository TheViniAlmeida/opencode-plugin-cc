import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

export const PLAN = {
  rationale: 'Deliberately cyclic plan.',
  subtasks: [
    { id: 'a', title: 'First', prompt: 'Needs b.', kind: 'ask', dependsOn: ['b'] },
    { id: 'b', title: 'Second', prompt: 'Needs a.', kind: 'ask', dependsOn: ['a'] },
    { id: 'c', title: 'Third', prompt: 'Independent.', kind: 'ask', dependsOn: [] },
  ],
};

export default makeOrchestrateScenario({ plan: PLAN });
