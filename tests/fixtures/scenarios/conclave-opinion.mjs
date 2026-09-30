// Distinct member positions; the judge fails so the conclave exercises its warning path.
import { makeConclaveScenario, STRUCTURED_ERROR } from './_conclave-common.mjs';
export default makeConclaveScenario({ judge: () => ({ error: STRUCTURED_ERROR, text: 'The members mostly agree.' }) });
