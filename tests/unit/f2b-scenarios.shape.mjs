const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export function validateReviewShapeForFixture(data) {
  if (!['approve', 'needs-attention'].includes(data?.verdict)) return 'verdict';
  if (typeof data.summary !== 'string' || !data.summary) return 'summary';
  if (!Array.isArray(data.findings) || !Array.isArray(data.next_steps)) return 'arrays';
  for (const f of data.findings) {
    if (!SEVERITIES.includes(f.severity)) return 'severity';
    for (const key of ['title', 'body', 'file', 'recommendation']) if (typeof f[key] !== 'string') return key;
    if (!Number.isInteger(f.line_start) || !Number.isInteger(f.line_end)) return 'lines';
    if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) return 'confidence';
  }
  return null;
}
