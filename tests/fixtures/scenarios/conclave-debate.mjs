// DeepSeek changes its position during debate; the other members keep theirs.
import { makeConclaveScenario, debateAnswer } from './_conclave-common.mjs';
export default makeConclaveScenario({ debate: ({ body, family }) => ({ structured: debateAnswer(family, body, { changed: family === 'deepseek' }) }) });
