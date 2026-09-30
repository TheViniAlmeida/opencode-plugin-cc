// Kimi emits no turn, allowing the plugin member timeout to abort it.
import { makeConclaveScenario, memberAnswer, debateAnswer, HANG } from './_conclave-common.mjs';
export default makeConclaveScenario({
  member: ({ family }) => family === 'kimi' ? HANG : { structured: memberAnswer(family) },
  debate: ({ body, family }) => family === 'kimi' ? HANG : { structured: debateAnswer(family, body) },
});
