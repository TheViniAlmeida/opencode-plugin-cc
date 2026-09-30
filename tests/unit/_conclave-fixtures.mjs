// Shared fixtures for conclave unit tests (not a test file).
export const PROVIDER = 'omniroute-personal';
export const DS = `${PROVIDER}/opencode-go/deepseek-v4.1-flash`;
export const QW = `${PROVIDER}/opencode-go/qwen3.8-max`;
export const KM = `${PROVIDER}/opencode-go/kimi-k3`;
export const EQ = 'omniroute-work/opencode-go/deepseek-v4-flash'; // same id as the F1 provider.json fixture

const MODEL_ROWS = [
  { full: DS, name: 'DeepSeek V4.1 Flash' },
  { full: QW, name: 'Qwen3.8 Max' },
  { full: KM, name: 'Kimi K3' },
  { full: EQ, name: 'DeepSeek V4 Flash (EQ)' },
];

export function makeCatalog(rows = MODEL_ROWS, connected = [PROVIDER, 'omniroute-work']) {
  const models = rows.map(({ full, name }) => {
    const i = full.indexOf('/');
    return { providerID: full.slice(0, i), modelID: full.slice(i + 1), full, name, variants: [], limit: {}, cost: {} };
  });
  return { connected: new Set(connected), models, byFull: new Map(models.map((m) => [m.full, m])) };
}

export function member(label, full) {
  const i = full.indexOf('/');
  return { label, providerID: full.slice(0, i), modelID: full.slice(i + 1), full, source: '--models' };
}

export const MEMBERS = [member('A', DS), member('B', QW), member('C', KM)];

export function answer(overrides = {}) {
  return {
    position: 'Use a write-ahead log.',
    confidence: 0.8,
    key_points: ['Durability matters more than latency.'],
    risks: ['Extra disk writes.'],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: 'writes happen in place' }],
    would_change_mind_if: 'Benchmarks show the log doubles latency.',
    ...overrides,
  };
}

export function debateAnswer(target, overrides = {}) {
  return { ...answer(), critiques: [{ target, point: 'No numbers behind the latency claim.' }], changed: false, ...overrides };
}

export function synthesis(labels, overrides = {}) {
  return {
    consensus: ['Durability is the main concern.'],
    disagreements: [{ topic: 'Mechanism', positions: [{ members: [labels[0]], stance: 'write-ahead log' }, { members: labels.slice(1), stance: 'backups' }] }],
    weighted_position: 'Use a write-ahead log.',
    confidence: 0.7,
    recommendation: 'Prototype the log and measure latency.',
    minority_reports: [{ members: [labels.at(-1)], summary: 'Backups may be enough for low write volume.' }],
    ...overrides,
  };
}

export function ok(structured, sessionID) {
  return { status: 'completed', sessionID, structured, finalText: '', errorType: undefined };
}

export function failed(errorType, { sessionID = null, finalText = '', errorClass = 'recoverable' } = {}) {
  return { status: 'failed', sessionID, structured: null, finalText, errorType, errorClass, errorMessage: `${errorType} happened` };
}
