// Review mode with overlapping and separated findings for clustering coverage.
import { makeConclaveScenario } from './_conclave-common.mjs';
const finding = (file, line_start, line_end, title, severity, confidence) => ({ severity, title, body: `${title}.`, file, line_start, line_end, confidence, recommendation: `Fix: ${title.toLowerCase()}.` });
export const REVIEWS = {
  deepseek: { verdict: 'needs-attention', summary: 'Division by zero and an off-by-one.', findings: [finding('src/calc.js', 10, 12, 'Division by zero when count is 0', 'high', 0.9), finding('src/list.js', 5, 5, 'Off-by-one in loop bound', 'medium', 0.6), finding('', 1, 1, 'Missing tests for calc module', 'low', 0.5)], next_steps: ['Guard the division.'] },
  qwen: { verdict: 'needs-attention', summary: 'Unsafe division.', findings: [finding('src/calc.js', 13, 14, 'Possible division by zero on empty count', 'critical', 0.7), finding('src/list.js', 40, 41, 'Off-by-one in loop bound', 'medium', 0.8), finding('N/A', 1, 1, 'Missing tests for calc module', 'low', 0.4)], next_steps: ['Check count before dividing.'] },
  kimi: { verdict: 'approve', summary: 'Minor concern only.', findings: [finding('src/calc.js', 30, 31, 'Division by zero when count is 0', 'high', 0.5)], next_steps: [] },
};
export default makeConclaveScenario({ review: ({ family }) => ({ structured: REVIEWS[family] ?? REVIEWS.kimi }) });
