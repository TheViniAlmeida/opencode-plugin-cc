// Shared behavior for the conclave scenarios (not a scenario by itself).
// Every scenario decides per request: member (round 1), debate (rounds 2..N), judge or review,
// using the schema embedded in the V2 text prompt and the session model.

export const HANG = Symbol('hang');

export function textOf(body) {
  return body?.text ?? '';
}

export function kindOf(body) {
  const prompt = textOf(body);
  // Text mode: the output contract embeds the schema, but peer answers and review findings can
  // carry their own "title" fields earlier in the prompt, so look for the known schema titles.
  const embedded = new Set([...prompt.matchAll(/"title"\s*:\s*"(Conclave(?:Synthesis|Debate|Member))"/g)].map((m) => m[1]));
  const embeddedTitle = ['ConclaveSynthesis', 'ConclaveDebate', 'ConclaveMember'].find((t) => embedded.has(t));
  const title = embeddedTitle ?? null;
  if (title === 'ConclaveMember') return 'member';
  if (title === 'ConclaveDebate') return 'debate';
  if (title === 'ConclaveSynthesis') return 'judge';
  return 'review';
}

export function familyOf(body) {
  const id = String(body?.model?.id ?? '').toLowerCase();
  for (const family of ['deepseek', 'qwen', 'kimi']) if (id.includes(family)) return family;
  return 'other';
}

export function tagList(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const POSITIONS = {
  deepseek: { position: 'Add a write-ahead log before applying changes.', confidence: 0.8 },
  qwen: { position: 'Apply changes in place and rely on nightly backups.', confidence: 0.6 },
  kimi: { position: 'Add a write-ahead log, but batch fsync calls.', confidence: 0.7 },
  other: { position: 'Measure first, then decide.', confidence: 0.5 },
};

export function memberAnswer(family, overrides = {}) {
  const base = POSITIONS[family] ?? POSITIONS.other;
  return {
    position: base.position,
    confidence: base.confidence,
    key_points: ['Durability matters more than raw latency here.'],
    risks: ['More disk writes per change.'],
    evidence: [{ file: 'src/store.js', line_start: 10, line_end: 20, note: 'writes happen in place' }],
    would_change_mind_if: 'Benchmarks show the log doubles write latency.',
    ...overrides,
  };
}

export function debateAnswer(family, body, { changed = false, overrides = {} } = {}) {
  const peers = tagList(textOf(body), 'peer_labels');
  return {
    ...memberAnswer(family),
    ...(changed ? { position: 'After the debate: add a write-ahead log with batched fsync.', confidence: 0.75 } : {}),
    critiques: peers.slice(0, 1).map((target) => ({ target, point: 'The latency argument has no numbers behind it.' })),
    changed,
    ...overrides,
  };
}

export function synthesisFor(body) {
  const labels = tagList(textOf(body), 'labels');
  return {
    consensus: ['Durability is the main concern.'],
    disagreements: [{ topic: 'How to guarantee durability', positions: [{ members: labels.slice(0, 1), stance: 'write-ahead log' }, { members: labels.slice(1), stance: 'in-place writes plus backups' }] }],
    weighted_position: 'Add a write-ahead log.', confidence: 0.7,
    recommendation: 'Prototype the log and measure write latency.',
    minority_reports: [{ members: labels.slice(-1), summary: 'Backups may be enough for low write volume.' }],
  };
}

export function reviewAnswer() {
  return { verdict: 'approve', summary: 'No material issues.', findings: [], next_steps: [] };
}

export const STRUCTURED_ERROR = { type: 'provider.output', message: 'O modelo não produziu JSON válido.' };

const DEFAULTS = {
  member: ({ family }) => ({ structured: memberAnswer(family) }),
  debate: ({ family, body }) => ({ structured: debateAnswer(family, body) }),
  judge: ({ body }) => ({ structured: synthesisFor(body) }),
  review: () => ({ structured: reviewAnswer() }),
};

export function makeConclaveScenario(handlers = {}) {
  return {
    onPrompt(fake, sessionID, body) {
      const context = { ...body, model: fake.state.sessions[sessionID]?.model };
      const kind = kindOf(context);
      const handler = handlers[kind] ?? DEFAULTS[kind];
      const outcome = handler({ fake, sessionID, body: context, family: familyOf(context) });
      if (outcome === HANG) return;
      const turn = { delayMs: 20, text: '', ...outcome };
      if (turn.structured !== undefined) turn.text = `\`\`\`json\n${JSON.stringify(turn.structured)}\n\`\`\``;
      delete turn.structured;
      fake.emitTurn(sessionID, turn);
    },
  };
}
