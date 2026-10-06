// Members name themselves, their vendor and provider; the plugin must scrub these before later prompts.
import { makeConclaveScenario, memberAnswer, debateAnswer } from './_conclave-common.mjs';
const VENDOR = { deepseek: 'DeepSeek', qwen: 'Alibaba', kimi: 'Moonshot', other: 'Acme' };
function identity(body, family) { return `I am ${body.model.id} served by ${body.model.providerID}, a ${family.toUpperCase()} model from ${VENDOR[family]}.`; }
export default makeConclaveScenario({
  member: ({ body, family }) => ({ structured: memberAnswer(family, {
    position: `${identity(body, family)} ${memberAnswer(family).position}`,
    key_points: [`As ${family}, I trust durability.`, `${body.model.providerID}/${body.model.id} says: measure first.`],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: `checked by ${body.model.id}` }],
  }) }),
  debate: ({ body, family }) => ({ structured: debateAnswer(family, body, { overrides: { position: `${identity(body, family)} Still the same view.` } }) }),
});
