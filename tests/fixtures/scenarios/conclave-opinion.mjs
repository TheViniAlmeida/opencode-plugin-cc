// Distinct member positions; the judge fails so the conclave exercises its warning path.
import { makeConclaveScenario } from './_conclave-common.mjs';
export default makeConclaveScenario({ judge: () => ({ text: 'The members mostly agree.' }) });
