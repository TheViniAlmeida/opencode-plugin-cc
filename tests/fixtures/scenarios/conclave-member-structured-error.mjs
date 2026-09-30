// Qwen returns a structured-output failure with raw text; other members answer normally.
import { makeConclaveScenario, memberAnswer, STRUCTURED_ERROR } from './_conclave-common.mjs';
export default makeConclaveScenario({ member: ({ family }) => family === 'qwen'
  ? { error: STRUCTURED_ERROR, text: 'I think the log is a good idea, but I cannot format it.' }
  : { structured: memberAnswer(family) } });
