import { makeOrchestrateScenario } from '../orchestrate-turns.mjs';

export default makeOrchestrateScenario({
  plannerError: { name: 'StructuredOutputError', data: { message: 'model output did not match the schema', retries: 2 } },
});
