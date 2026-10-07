// Qwen returns malformed text; other members answer with JSON.
import { makeConclaveScenario, memberAnswer } from './_conclave-common.mjs';
export default makeConclaveScenario({ member: ({ family }) => family === 'qwen'
  ? { text: 'I think the log is a good idea, but I cannot format it.' }
  : { structured: memberAnswer(family) } });
