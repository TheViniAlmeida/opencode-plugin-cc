import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

// Two independent write subtasks plus two reads: rejected without --write; with --write the
// writes must run one after the other while the reads run in parallel.
export const PLAN = {
  rationale: 'Two edits and two lookups.',
  subtasks: [
    { id: 'w1', title: 'Edit one', prompt: 'Change file one.', kind: 'task', files: ['one.txt'], dependsOn: [] },
    { id: 'w2', title: 'Edit two', prompt: 'Change file two.', kind: 'task', files: ['two.txt'], dependsOn: [] },
    { id: 'r1', title: 'Look one', prompt: 'Read file one.', kind: 'ask', dependsOn: [] },
    { id: 'r2', title: 'Look two', prompt: 'Read file two.', kind: 'ask', dependsOn: [] },
  ],
};

export default makeOrchestrateScenario({ plan: PLAN });
