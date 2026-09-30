import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

export const PLAN = {
  rationale: 'Two independent questions.',
  subtasks: [
    { id: 'a', title: 'Question A', prompt: 'Answer A.', kind: 'ask', dependsOn: [] },
    { id: 'b', title: 'Question B', prompt: 'Answer B.', kind: 'ask', dependsOn: [] },
  ],
};

export default makeOrchestrateScenario({ plan: PLAN, synthesisText: 'SYNTHESIS-OK: A and B agree' });
